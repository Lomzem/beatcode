import { resolve } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Effect } from 'effect';
import { loadPackage } from './package.ts';
import { devCall } from './operator.ts';
import { OperatorError, operatorAsync, operatorSync } from './effects.ts';

const publish = Effect.gen(function* () {
	const dir = resolve(process.argv[2] ?? '');
	const environmentFlag = process.argv.indexOf('--env-id');
	const envId =
		environmentFlag < 0 ? 'gcc15.3-gvisor-seccomp-r1-dev' : process.argv[environmentFlag + 1];
	if (!envId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(envId))
		return yield* new OperatorError({ message: 'ENVIRONMENT_ID_REQUIRED' });
	// A symlinked package or checkout would pass the prefix while loading files from elsewhere.
	// Canonical resolution rejects every symlinked component before privacy, reads or upload.
	const canonical = yield* operatorSync('PRIVATE_REPOSITORY_REQUIRED', () => realpathSync(dir));
	if (canonical !== dir || !dir.startsWith('/home/lomzem/proj/beatcode-problems/'))
		return yield* new OperatorError({ message: 'PRIVATE_REPOSITORY_REQUIRED' });
	const privacy = yield* operatorSync('PRIVATE_REPOSITORY_REQUIRED', () =>
		JSON.parse(
			execFileSync(
				'gh',
				['repo', 'view', 'Lomzem/beatcode-problems', '--json', 'isPrivate,visibility'],
				{ encoding: 'utf8' }
			)
		)
	);
	if (privacy.isPrivate !== true || privacy.visibility !== 'PRIVATE')
		return yield* new OperatorError({ message: 'PRIVATE_REPOSITORY_REQUIRED' });
	const p = yield* operatorAsync('PACKAGE_INVALID', () => loadPackage(dir));
	if (p.metadata.version > 1 && environmentFlag < 0)
		return yield* new OperatorError({
			message: 'EXPLICIT_ENVIRONMENT_ID_REQUIRED_FOR_NEW_VERSION'
		});
	const { runnerSourceSha256: _, ...image } = yield* operatorSync('JUDGE_IMAGE_REQUIRED', () =>
		JSON.parse(readFileSync('judge/image.json', 'utf8'))
	);
	void _;
	const { judgeEnvId } = yield* devCall<{ judgeEnvId: string }>('problems:_registerEnvironment', {
		...image,
		envId
	});
	const { uploadUrl } = yield* devCall<{ uploadUrl: string }>('problems:_uploadUrl', {});
	// One signal bounds the request and its body read: interruption or the deadline aborts both.
	// Aborting stops only this client; storage may still have accepted the blob.
	let failure = 'UPLOAD_FAILED';
	const { storageId } = yield* Effect.tryPromise({
		try: async (signal) => {
			const response = await fetch(uploadUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/gzip' },
				body: new Uint8Array(p.blob),
				signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
				redirect: 'error'
			});
			if (!response.ok) throw new Error();
			failure = 'UPLOAD_RESPONSE_INVALID';
			// Convex validates the ID format at _createVersion; reject only shapes it can never accept.
			const body: unknown = await response.json();
			const storageId =
				typeof body === 'object' && body !== null && 'storageId' in body
					? body.storageId
					: undefined;
			if (typeof storageId !== 'string' || storageId === '') throw new Error();
			return { storageId };
		},
		catch: () => new OperatorError({ message: failure })
	});
	const result = yield* devCall<{ problemVersionId: string }>('problems:_createVersion', {
		...p.metadata,
		judgeEnvId,
		testsStorageId: storageId
	});
	console.log(JSON.stringify({ slug: p.metadata.slug, ...result }));
});

await Effect.runPromise(publish);
