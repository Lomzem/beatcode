import { fileURLToPath } from 'node:url';
import {
	readFileSync,
	writeFileSync,
	mkdirSync,
	lstatSync,
	existsSync,
	realpathSync
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Infer } from 'convex/values';
import { Effect } from 'effect';
import { internal } from '../../convex/_generated/api.js';
import type { Id } from '../../convex/_generated/dataModel.js';
import {
	ALL_HISTORY_POLICY,
	ALL_HISTORY_POLICY_SPEC,
	productionBaseline
} from '../../convex/game/validators.ts';
import { PROD_CALIBRATION, serializeReferences } from '../../shared/calibrationDeployment.ts';
import { serializeEnvironment, type JudgeEnvironmentIdentity } from '../../shared/environment.ts';
import { sha256 } from './hash.ts';
import { EXECUTION_POLICY } from '../../shared/calibrationDeployment.ts';
import { loadPackage } from './package.ts';
import { productionTransport } from './productionTransport.ts';
import { OperatorError, operatorSync, operatorAsync } from './effects.ts';

// Hash exactly the reviewed release boundary; root creates GO only after review of these bytes.
const releaseFiles = [
	'convex/calibration.ts',
	'convex/calibrationConfig.ts',
	'convex/calibrationState.ts',
	'convex/problems.ts',
	'convex/schema.ts',
	'convex/game/validators.ts',
	'convex/game/catalog.ts',
	'judge/controller.ts',
	'judge/modal.ts',
	'shared/calibrationDeployment.ts',
	'shared/environment.ts',
	'scripts/problems/package.ts',
	'scripts/problems/hash.ts',
	'scripts/problems/production.ts',
	'scripts/problems/productionTransport.ts'
];
interface Manifest {
	format: 'beatcode-production-calibration/1';
	go: true;
	sourceCommit: string;
	sourceSha256: string;
	decisionPolicySha256: string;
	executionPolicy: string;
	maxJobs: 150;
	maxSeconds: 6000;
	environment: JudgeEnvironmentIdentity;
	environmentSha256: string;
	productionApp: { appName: typeof PROD_CALIBRATION.appName; appId: string };
	packages: { slug: string; productionBaseline: Infer<typeof productionBaseline> }[];
}
const root = resolve('.scratch/competitive-leetcode/production-calibration');
function noSymlinks(path: string) {
	for (let p = resolve(path); ; p = dirname(p)) {
		if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error();
		if (dirname(p) === p) return;
	}
}
function save(name: string, value: unknown, exclusive = false) {
	return operatorSync('PRODUCTION_LEDGER_WRITE_FAILED', () => {
		noSymlinks(root);
		mkdirSync(root, { recursive: true, mode: 0o700 });
		if ((lstatSync(root).mode & 0o077) !== 0) throw new Error();
		const path = resolve(root, name);
		if (dirname(path) !== root) throw new Error();
		noSymlinks(path);
		if (existsSync(path) && (lstatSync(path).mode & 0o077) !== 0) throw new Error();
		writeFileSync(path, JSON.stringify(value, null, 2), {
			mode: 0o600,
			flag: exclusive ? 'wx' : 'w'
		});
	});
}
const selectedPolicy = { decisionPolicy: ALL_HISTORY_POLICY } as const;
const production = Effect.gen(function* () {
	const [command, manifestPath, subject, ...extra] = process.argv.slice(2);
	if (
		![
			'preflight',
			'status',
			'registerenv',
			'publish',
			'calibrate',
			'cleanup',
			'reconcile'
		].includes(command) ||
		!manifestPath ||
		extra.length ||
		['publish', 'calibrate', 'cleanup', 'reconcile'].includes(command) !== !!subject ||
		process.argv.slice(2).some((a) => a.startsWith('--'))
	)
		return yield* new OperatorError({ message: 'PRODUCTION_COMMAND_INVALID' });
	const sourceRoot = yield* operatorSync('PRODUCTION_SOURCE_ROOT_INVALID', () => {
		const checkout = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
		if (realpathSync(process.cwd()) !== checkout) throw new Error();
		// Node resolves imports from the executing module, not cwd. Reject renamed copies and
		// first-party symlinks escaping the reviewed checkout before reading any authorization.
		const modules = [
			['scripts/problems/production.ts', import.meta.url],
			['scripts/problems/productionTransport.ts', import.meta.resolve('./productionTransport.ts')],
			['scripts/problems/package.ts', import.meta.resolve('./package.ts')],
			['scripts/problems/hash.ts', import.meta.resolve('./hash.ts')],
			['scripts/problems/effects.ts', import.meta.resolve('./effects.ts')],
			[
				'shared/calibrationDeployment.ts',
				import.meta.resolve('../../shared/calibrationDeployment.ts')
			],
			['shared/environment.ts', import.meta.resolve('../../shared/environment.ts')],
			['convex/game/validators.ts', import.meta.resolve('../../convex/game/validators.ts')],
			['convex/_generated/api.js', import.meta.resolve('../../convex/_generated/api.js')]
		];
		for (const [path, url] of modules)
			if (realpathSync(fileURLToPath(url)) !== resolve(checkout, path)) throw new Error();
		const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
			cwd: checkout,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe']
		}).trim();
		if (realpathSync(gitRoot) !== checkout) throw new Error();
		return checkout;
	});
	const manifest = yield* operatorSync('PRODUCTION_GO_INVALID', () => {
		noSymlinks(manifestPath);
		const stat = lstatSync(manifestPath);
		if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 1024 * 1024) throw new Error();
		const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
		const head = execFileSync('git', ['rev-parse', 'HEAD'], {
			cwd: sourceRoot,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe']
		}).trim();
		execFileSync(
			'git',
			[
				'diff',
				'--no-ext-diff',
				'--quiet',
				'HEAD',
				'--',
				'convex',
				'judge',
				'shared',
				'scripts/problems'
			],
			{ cwd: sourceRoot, stdio: ['ignore', 'pipe', 'pipe'] }
		);
		const sourceHash = sha256(
			JSON.stringify(
				releaseFiles.map((p) => {
					const path = resolve(sourceRoot, p);
					noSymlinks(path);
					return [p, sha256(readFileSync(path))];
				})
			)
		);
		if (
			m.format !== 'beatcode-production-calibration/1' ||
			m.go !== true ||
			m.sourceCommit !== head ||
			m.sourceSha256 !== sourceHash ||
			m.decisionPolicySha256 !== sha256(ALL_HISTORY_POLICY_SPEC) ||
			m.executionPolicy !== EXECUTION_POLICY ||
			m.maxJobs !== 150 ||
			m.maxSeconds !== 6000 ||
			m.productionApp.appName !== PROD_CALIBRATION.appName ||
			!/^ap-[A-Za-z0-9]{22}$/.test(m.productionApp.appId) ||
			m.environmentSha256 !== sha256(serializeEnvironment(m.environment)) ||
			m.environment.runtime !== 'gvisor' ||
			m.environment.cpu !== 1 ||
			!Array.isArray(m.packages) ||
			!m.packages.length ||
			new Set(m.packages.map((p) => p.slug)).size !== m.packages.length
		)
			throw new Error();
		for (const p of m.packages) {
			const b = p.productionBaseline;
			if (
				!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.slug) ||
				b.originDeployment !== 'dev:descriptive-scorpion-877' ||
				(b.originPolicy === 'legacy-fixed-spread-v1'
					? b.decisionPolicySha256 != null
					: b.originPolicy !== ALL_HISTORY_POLICY ||
						b.decisionPolicySha256 !== m.decisionPolicySha256) ||
				!b.originVersionId ||
				!Number.isSafeInteger(b.originVersion) ||
				b.originVersion < 1 ||
				!Number.isInteger(b.publicTimeMs) ||
				b.publicTimeMs < 500 ||
				b.publicTimeMs > 3000 ||
				b.publicTimeMs % 100 ||
				[b.packageSha256, b.testsSha256, b.referencesSha256, b.evidenceSha256].some(
					(h) => !/^[a-f0-9]{64}$/.test(h)
				)
			)
				throw new Error();
		}
		return m;
	});
	if (
		!['status', 'cleanup', 'reconcile'].includes(command) &&
		(yield* operatorSync('PRODUCTION_LEDGER_INVALID', () => {
			noSymlinks(root);
			return existsSync(resolve(root, 'STOP.json'));
		}))
	)
		return yield* new OperatorError({ message: 'PRODUCTION_STOP_REQUIRES_REVIEW' });
	yield* save('GO.json', {
		sourceCommit: manifest.sourceCommit,
		sourceSha256: manifest.sourceSha256,
		decisionPolicySha256: manifest.decisionPolicySha256,
		environmentSha256: manifest.environmentSha256,
		appId: manifest.productionApp.appId
	});
	const client = yield* productionTransport();
	const status = () =>
		Effect.gen(function* () {
			const receipt = yield* client.query(internal.calibrationState._status, {});
			if (
				receipt.deployment !== PROD_CALIBRATION.deployment ||
				receipt.campaign !== PROD_CALIBRATION.campaign ||
				receipt.maxJobs !== 150 ||
				receipt.maxSeconds !== 6000 ||
				receipt.executionPolicy !== EXECUTION_POLICY
			)
				return yield* new OperatorError({ message: 'PRODUCTION_TARGET_MISMATCH' });
			yield* save('status.json', receipt);
			return receipt;
		});
	const initial = yield* status();
	if (command === 'status' || command === 'preflight') return;
	if (command === 'cleanup' || command === 'reconcile') {
		if (!initial.jobs.some((j) => j.reservationId === subject))
			return yield* new OperatorError({ message: 'PRODUCTION_RESERVATION_REQUIRED' });
		yield* client.action(
			command === 'cleanup' ? internal.calibration._cleanup : internal.calibration._reconcile,
			{ reservationId: subject as Id<'auditLog'> }
		);
		yield* status();
		return;
	}
	if (initial.pending || initial.sharedInFlight)
		return yield* new OperatorError({ message: 'PRODUCTION_PENDING_REQUIRES_REVIEW' });
	if (command === 'registerenv' || command === 'publish') {
		const { judgeEnvId } = yield* client.mutation(internal.problems._registerEnvironment, {
			...manifest.environment,
			runtime: 'gvisor',
			cpu: 1,
			productionApp: manifest.productionApp
		});
		if (command === 'registerenv') {
			yield* save('environment.json', {
				judgeEnvId,
				environmentSha256: manifest.environmentSha256
			});
			return;
		}
		const approved = manifest.packages.find((p) => p.slug === subject);
		if (!approved) return yield* new OperatorError({ message: 'PRODUCTION_PACKAGE_NOT_APPROVED' });
		const dir = `/home/lomzem/proj/beatcode-problems/${approved.slug}`;
		yield* operatorSync('PRIVATE_REPOSITORY_REQUIRED', () => {
			noSymlinks(dir);
			if (realpathSync(dir) !== dir) throw new Error();
			const privacy = JSON.parse(
				execFileSync(
					'gh',
					['repo', 'view', 'Lomzem/beatcode-problems', '--json', 'isPrivate,visibility'],
					{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
				)
			);
			if (privacy.isPrivate !== true || privacy.visibility !== 'PRIVATE') throw new Error();
		});
		const p = yield* operatorAsync('PACKAGE_INVALID', () => loadPackage(dir));
		const b = approved.productionBaseline;
		if (
			p.metadata.version !== b.originVersion ||
			p.metadata.packageSha256 !== b.packageSha256 ||
			p.metadata.testsSha256 !== b.testsSha256 ||
			sha256(serializeReferences(p.metadata.referenceSolutions)) !== b.referencesSha256
		)
			return yield* new OperatorError({ message: 'PRODUCTION_PACKAGE_MISMATCH' });
		const { uploadUrl } = yield* client.mutation(internal.problems._uploadUrl, {});
		const { storageId } = yield* operatorAsync('PRODUCTION_UPLOAD_FAILED', async () => {
			if (new URL(uploadUrl).origin !== PROD_CALIBRATION.url) throw new Error();
			const response = await fetch(uploadUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/gzip' },
				body: new Uint8Array(p.blob),
				signal: AbortSignal.timeout(30000),
				redirect: 'error'
			});
			if (!response.ok) throw new Error();
			return (await response.json()) as { storageId: Id<'_storage'> };
		});
		const published = yield* client.mutation(internal.problems._createVersion, {
			...p.metadata,
			judgeEnvId,
			testsStorageId: storageId,
			productionBaseline: b
		});
		yield* save(`${published.problemVersionId}.json`, {
			...published,
			packageSha256: b.packageSha256,
			testsSha256: b.testsSha256
		});
		return;
	}
	const problemVersionId = subject as Id<'problemVersions'>;
	const input = yield* client.query(internal.problems._calibrationInput, {
		problemVersionId,
		...selectedPolicy
	});
	if (!input?.environment || !input.version.referenceSolutions || !input.version.productionBaseline)
		return yield* new OperatorError({ message: 'PRODUCTION_VERSION_REQUIRED' });
	const { version: p, environment: e } = input;
	const approved = manifest.packages.find(
		(x) => x.productionBaseline.packageSha256 === p.packageSha256
	);
	if (
		!approved ||
		Object.entries(approved.productionBaseline).some(
			([k, v]) => p.productionBaseline![k as keyof typeof p.productionBaseline] !== v
		) ||
		sha256(serializeEnvironment(e)) !== manifest.environmentSha256 ||
		e.productionApp?.appName !== manifest.productionApp.appName ||
		e.productionApp.appId !== manifest.productionApp.appId ||
		sha256(serializeReferences(p.referenceSolutions!)) !==
			approved.productionBaseline.referencesSha256
	)
		return yield* new OperatorError({ message: 'PRODUCTION_BINDING_MISMATCH' });
	const refs = p.referenceSolutions!;
	const required = [
		...[0, 1].map((index) => ({ role: 'validator' as const, index, repeat: 0 })),
		...refs.timeLimitExceeded.map((_, index) => ({
			role: 'slowSample' as const,
			index,
			repeat: 0
		})),
		...refs.accepted.flatMap((_, index) =>
			Array.from({ length: 8 }, (_, repeat) => ({ role: 'accepted' as const, index, repeat }))
		),
		...refs.timeLimitExceeded.flatMap((_, index) =>
			Array.from({ length: 8 }, (_, repeat) => ({
				role: 'timeLimitExceeded' as const,
				index,
				repeat
			}))
		),
		...refs.wrongAnswer.map((_, index) => ({ role: 'wrongAnswer' as const, index, repeat: 0 }))
	];
	const missing = required.filter(
		(job) =>
			!initial.jobs.some(
				(j) =>
					j.problemVersionId === problemVersionId &&
					j.role === job.role &&
					j.index === job.index &&
					j.repeat === job.repeat
			)
	).length;
	if (initial.jobs.length + missing > 150)
		return yield* new OperatorError({ message: 'PRODUCTION_CAPACITY' });
	for (const job of required) {
		const receipt = yield* status();
		const owned = receipt.jobs.filter((j) => j.problemVersionId === problemVersionId);
		if (
			owned.some(
				(j) =>
					!j.released ||
					!j.result ||
					j.result.verdict === 'ERROR' ||
					j.retryOf ||
					j.executionPolicy !== EXECUTION_POLICY ||
					j.deployment !== PROD_CALIBRATION.deployment ||
					j.appId !== manifest.productionApp.appId
			)
		)
			return yield* new OperatorError({ message: 'PRODUCTION_HISTORY_REQUIRES_REVIEW' });
		const prior = owned.find(
			(j) => j.role === job.role && j.index === job.index && j.repeat === job.repeat
		);
		if (!prior && (receipt.pending || receipt.sharedInFlight || receipt.jobs.length >= 150))
			return yield* new OperatorError({ message: 'PRODUCTION_CAPACITY' });
		const result =
			prior?.result ??
			(yield* client.action(internal.calibration._job, {
				problemVersionId,
				...job,
				...selectedPolicy
			}));
		yield* status();
		if (
			!result ||
			(job.role === 'wrongAnswer'
				? result.verdict !== 'WA'
				: job.role === 'timeLimitExceeded'
					? !['AC', 'TLE'].includes(result.verdict)
					: result.verdict !== 'AC')
		)
			return yield* new OperatorError({ message: 'PRODUCTION_REFERENCE_FAILED' });
	}
	const decision = yield* client.action(internal.calibration._finalizeProduction, {
		problemVersionId
	});
	yield* save(`${problemVersionId}-decision.json`, decision);
	if (!decision.activated)
		return yield* new OperatorError({ message: 'PRODUCTION_FINALIZATION_REJECTED' });
});

try {
	await Effect.runPromise(Effect.scoped(production));
} catch {
	// Fixed STOP reason only. Neither Convex payloads nor process exceptions reach stdout/stderr.
	await Effect.runPromise(
		save('STOP.json', { outcome: 'PRODUCTION_STOP_REQUIRES_REVIEW' }, true)
	).catch(() => undefined);
	process.exitCode = 1;
}
