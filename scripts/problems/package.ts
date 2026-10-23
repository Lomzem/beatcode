import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { sha256 } from '../../judge/controller.ts';
import { Data, Effect } from 'effect';

class PackageReadError extends Data.TaggedError('PackageReadError')<{
	readonly message: string;
}> {}
type PackageFile = { name: string; bytes: Buffer };

function readPackageFiles(dir: string) {
	return Effect.gen(function* () {
		const files: PackageFile[] = [];
		function walk(rel: string): Effect.Effect<void, PackageReadError> {
			return Effect.gen(function* () {
				const path = join(dir, rel);
				const stat = yield* Effect.tryPromise({
					try: () => lstat(path),
					catch: () => new PackageReadError({ message: 'PACKAGE_READ' })
				});
				if (stat.isSymbolicLink())
					return yield* new PackageReadError({ message: 'PACKAGE_SYMLINK' });
				if (stat.isDirectory()) {
					const names = yield* Effect.tryPromise({
						try: () => readdir(path),
						catch: () => new PackageReadError({ message: 'PACKAGE_READ' })
					});
					for (const name of names.sort()) yield* walk(rel ? `${rel}/${name}` : name);
				} else if (stat.isFile()) {
					if (stat.size > 32 * 1024 * 1024)
						return yield* new PackageReadError({ message: 'PACKAGE_SIZE' });
					const bytes = yield* Effect.tryPromise({
						try: () => readFile(path),
						catch: () => new PackageReadError({ message: 'PACKAGE_READ' })
					});
					files.push({ name: rel, bytes });
				} else return yield* new PackageReadError({ message: 'PACKAGE_FILE' });
			});
		}
		for (const name of [
			'problem.yaml',
			'statement.md',
			'data',
			'submissions',
			'validator',
			'generators'
		])
			yield* walk(name);
		return files;
	});
}

/** JSON is the supported serialization of this package's YAML subset. No code executes. */
export function loadPackage(dir: string) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const files = yield* readPackageFiles(dir);
			return yield* Effect.try({
				try: () => decodePackage(dir, files),
				catch: (cause) =>
					new PackageReadError({
						message:
							cause instanceof Error && /^PACKAGE_[A-Z_]+$/.test(cause.message)
								? cause.message
								: 'PACKAGE_MANIFEST'
					})
			});
		})
	);
}

function decodePackage(dir: string, files: PackageFile[]) {
	const get = (name: string) => {
		const f = files.find((f) => f.name === name);
		if (!f) throw new Error('PACKAGE_MISSING');
		return f.bytes.toString('utf8');
	};
	const m = JSON.parse(get('problem.yaml'));
	if (
		m.format !== 'beatcode-problem/1' ||
		m.license !== 'original' ||
		m.checker !== 'tokens' ||
		!m.author ||
		!m.title ||
		m.slug !== basename(dir) ||
		!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(m.slug) ||
		![1, 2, 3].includes(m.difficulty) ||
		!Number.isSafeInteger(m.version) ||
		m.version < 1 ||
		m.calibration?.repeats !== 8 ||
		m.calibration?.ac_multiplier !== 2.5 ||
		m.calibration?.tle_multiplier !== 2.5
	)
		throw new Error('PACKAGE_MANIFEST');
	const l = m.limits;
	if (
		![256, 512].includes(l?.memory_mib) ||
		!Number.isInteger(l.output_kib) ||
		l.output_kib < 1 ||
		l.output_kib > 1024 ||
		!Number.isInteger(l.aggregate_ms) ||
		l.aggregate_ms < 1 ||
		l.aggregate_ms > 15000
	)
		throw new Error('PACKAGE_LIMITS');
	const tests: { name: string; kind: 'sample' | 'secret'; input: string; answer: string }[] = [];
	for (const kind of ['sample', 'secret'] as const) {
		const inputs = files.filter(
			(f) => f.name.startsWith(`data/${kind}/`) && f.name.endsWith('.in')
		);
		if (
			inputs.length < (kind === 'sample' ? 1 : 10) ||
			inputs.length > (kind === 'sample' ? 3 : 50)
		)
			throw new Error('PACKAGE_TEST_COUNT');
		for (const f of inputs) {
			const answer = get(f.name.replace(/\.in$/, '.ans'));
			const input = f.bytes.toString('utf8');
			if (Buffer.byteLength(answer) > l.output_kib * 1024) throw new Error('PACKAGE_OUTPUT');
			if (kind === 'sample' && Math.max(Buffer.byteLength(input), Buffer.byteLength(answer)) > 4096)
				throw new Error('PACKAGE_SAMPLE');
			tests.push({ name: f.name, kind, input, answer });
		}
		if (
			files.filter((f) => f.name.startsWith(`data/${kind}/`) && f.name.endsWith('.ans')).length !==
			inputs.length
		)
			throw new Error('PACKAGE_PAIR');
	}
	if (tests.reduce((n, t) => n + Buffer.byteLength(t.input), 0) > 32 * 1024 * 1024)
		throw new Error('PACKAGE_INPUT');
	const sources = (kind: string) => {
		const a = files
			.filter((f) => f.name.startsWith(`submissions/${kind}/`) && f.name.endsWith('.cpp'))
			.map((f) => f.bytes.toString('utf8'));
		if (!a.length) throw new Error('PACKAGE_REFERENCES');
		return a;
	};
	const referenceSolutions = {
		accepted: sources('accepted'),
		timeLimitExceeded: sources('time_limit_exceeded'),
		wrongAnswer: sources('wrong_answer'),
		validator: get('validator/validate.cpp')
	};
	const refs = [
		...referenceSolutions.accepted,
		...referenceSolutions.timeLimitExceeded,
		...referenceSolutions.wrongAnswer,
		referenceSolutions.validator
	];
	if (
		refs.some((s) => !s.trim() || Buffer.byteLength(s) > 65536) ||
		refs.reduce((n, s) => n + Buffer.byteLength(s), 0) > 400000
	)
		throw new Error('PACKAGE_SOURCE');
	const blob = gzipSync(JSON.stringify({ format: 'beatcode-tests/1', tests }));
	if (blob.length > 32 * 1024 * 1024) throw new Error('PACKAGE_BLOB');
	const statementMd = get('statement.md').replace(
		'The published version supplies the calibrated per-test time limit; this draft is not active.',
		'The calibrated per-test time limit is displayed separately in the problem limits.'
	);
	return {
		blob,
		metadata: {
			slug: m.slug as string,
			title: m.title as string,
			version: m.version as number,
			difficulty: m.difficulty as 1 | 2 | 3,
			statementMd,
			samples: tests
				.filter((t) => t.kind === 'sample')
				.map((t) => ({ input: t.input, output: t.answer })),
			limits: {
				timeMs: 3000,
				memoryMiB: l.memory_mib as number,
				outputKiB: l.output_kib as number,
				aggregateMs: l.aggregate_ms as number
			},
			testsSha256: sha256(blob),
			packageSha256: sha256(JSON.stringify(files.map((f) => [f.name, sha256(f.bytes)]))),
			referenceSolutions
		}
	};
}
