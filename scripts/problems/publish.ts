import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
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
	const privacy = yield* operatorSync('PRIVATE_REPOSITORY_REQUIRED', () =>
		JSON.parse(
			execFileSync(
				'gh',
				['repo', 'view', 'Lomzem/beatcode-problems', '--json', 'isPrivate,visibility'],
				{ encoding: 'utf8' }
			)
		)
	);
	if (
		privacy.isPrivate !== true ||
		privacy.visibility !== 'PRIVATE' ||
		!dir.startsWith('/home/lomzem/proj/beatcode-problems/')
	)
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
	const response = yield* operatorAsync('UPLOAD_FAILED', () =>
		fetch(uploadUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/gzip' },
			body: new Uint8Array(p.blob)
		})
	);
	if (!response.ok) return yield* new OperatorError({ message: 'UPLOAD_FAILED' });
	const { storageId } = yield* operatorAsync('UPLOAD_RESPONSE_INVALID', () => response.json());
	const result = yield* devCall<{ problemVersionId: string }>('problems:_createVersion', {
		...p.metadata,
		judgeEnvId,
		testsStorageId: storageId
	});
	console.log(JSON.stringify({ slug: p.metadata.slug, ...result }));
});

await Effect.runPromise(publish);
