import { Data, Effect } from 'effect';
import ciHeaders from './headers';
import { CI_BACKEND_URL } from './deployment';
import {
	openAccountRun,
	cleanupAccountRun,
	recoverAccountRuns,
	AccountResourceFailure
} from './clerk-resources';
import { runCommand as command, ProcessFailure } from './process';
import { mkdtemp, chmod, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

class CiFailure extends Data.TaggedError('CiFailure')<{ message: string }> {}
const step = <A>(operation: () => Promise<A>, message: string) =>
	Effect.tryPromise({ try: operation, catch: () => new CiFailure({ message }) });
const required = [
	'CONVEX_CI_DEPLOY_KEY',
	'CLERK_CI_SECRET_KEY',
	'PUBLIC_CONVEX_URL',
	'PUBLIC_CLERK_PUBLISHABLE_KEY',
	'CLERK_JWT_ISSUER_DOMAIN'
] as const;
const config = Effect.try({
	try: () => {
		if (required.some((key) => !process.env[key]))
			throw new Error('Authenticated CI configuration missing');
		const url = new URL(process.env.PUBLIC_CONVEX_URL!);
		const key = process.env.CONVEX_CI_DEPLOY_KEY!;
		if (
			url.origin !== CI_BACKEND_URL ||
			url.protocol !== 'https:' ||
			!key.startsWith(`dev:${url.hostname.split('.')[0]}|`) ||
			!process.env.CLERK_CI_SECRET_KEY!.startsWith('sk_test_') ||
			!process.env.PUBLIC_CLERK_PUBLISHABLE_KEY!.startsWith('pk_test_') ||
			!/^https:\/\/[a-z0-9-]+\.clerk\.accounts\.dev$/.test(process.env.CLERK_JWT_ISSUER_DOMAIN!)
		)
			throw new Error('Authenticated CI requires isolated DEV credentials');
		return { url: url.href, key };
	},
	catch: (error) =>
		new CiFailure({ message: error instanceof Error ? error.message : 'Invalid CI configuration' })
});

// Capture command diagnostics: Convex/Playwright failures can include private URLs,
// source, invitations and session data. Only fixed stage names reach Actions logs.

const startStage = (stage: 'deploy' | 'setup' | 'build' | 'matrix' | 'cleanup') => {
	const started = performance.now();
	return () => console.info(`CI stage: ${stage} ${Math.round(performance.now() - started)}ms`);
};

const program = Effect.gen(function* () {
	const { url, key } = yield* config;
	if (process.argv.includes('--validate')) return;
	const recoveryBase = resolve('.scratch/competitive-leetcode/ci-recovery');

	const directory = yield* Effect.acquireRelease(
		step(async () => {
			const path = await mkdtemp(join(tmpdir(), 'beatcode-auth-ci-'));
			await chmod(path, 0o700);
			return path;
		}, 'Private workspace failed'),
		(path) =>
			step(
				() => rm(path, { recursive: true, force: true }),
				'Private workspace cleanup failed'
			).pipe(Effect.orDie)
	);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		CONVEX_DEPLOY_KEY: key,
		MATCH_E2E_REQUIRED: '1',
		MATCH_E2E_URL: 'http://localhost:4173',
		MATCH_E2E_PRIVATE_DIR: directory,
		MATCH_E2E_RECOVERY_DIR: ''
	};
	delete env.CONVEX_DEPLOYMENT;
	const client = new ConvexHttpClient(url, {
		logger: false,
		fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30000) })
	});
	(client as ConvexHttpClient & { setAdminAuth(key: string): void }).setAdminAuth(key);
	const call = (name: string) =>
		step(
			() => client.action(makeFunctionReference<'action'>(name), {}),
			'CI backend fixture operation failed'
		);
	const clerk = (path: string, method = 'GET') =>
		step(async () => {
			const result = await fetch(`https://api.clerk.com/v1/${path}`, {
				method,
				signal: AbortSignal.timeout(5000),
				headers: { Authorization: `Bearer ${process.env.CLERK_CI_SECRET_KEY}` }
			});
			if (method === 'DELETE' && result.status === 404) return null;
			if (!result.ok) throw new Error('Clerk failed');
			return result.json();
		}, 'Clerk development cleanup failed');
	// Convex requires a package.json in the CLI working directory. Materialize
	// the root manifest unchanged for this separate artifact; never install here.
	yield* Effect.acquireRelease(
		step(async () => {
			await writeFile('tests/e2e/package.json', await readFile('package.json'), { flag: 'wx' });
		}, 'CI artifact manifest setup failed'),
		() =>
			step(
				() => rm('tests/e2e/package.json', { force: true }),
				'CI artifact manifest cleanup failed'
			).pipe(Effect.orDie)
	);
	const finishDeployment = startStage('deploy');
	console.info('Authenticated CI: deploy isolated test app');
	yield* command(
		[
			'bunx',
			'--no-install',
			'convex',
			'env',
			'set',
			'CLERK_JWT_ISSUER_DOMAIN',
			process.env.CLERK_JWT_ISSUER_DOMAIN!
		],
		'CI issuer configuration failed',
		env,
		resolve('tests/e2e')
	);
	yield* command(
		[
			'bunx',
			'--no-install',
			'convex',
			'deploy',
			'--yes',
			'--typecheck',
			'disable',
			'--codegen',
			'disable'
		],
		'CI app deployment failed',
		env,
		resolve('tests/e2e')
	);
	finishDeployment();
	const finishSetup = startStage('setup');
	yield* recoverAccountRuns(recoveryBase);
	const recovery = yield* openAccountRun(recoveryBase);
	env.MATCH_E2E_RECOVERY_DIR = recovery;
	yield* Effect.gen(function* () {
		yield* call('bootstrap:reset');
		yield* call('bootstrap:seed');
		const token = yield* clerk('testing_tokens', 'POST');
		yield* step(
			() =>
				writeFile(join(directory, 'testing-token.json'), JSON.stringify(token), { mode: 0o600 }),
			'Testing Token setup failed'
		);
		finishSetup();
		const finishBuild = startStage('build');
		console.info('Authenticated CI: build and run real hosted-account browser matrix');
		yield* command(['bun', 'run', 'build'], 'Authenticated frontend build failed', env);
		yield* command(
			['node', 'scripts/ops/security-headers.mjs'],
			'Authenticated frontend headers failed',
			env
		);
		yield* ciHeaders();
		finishBuild();
		const finishMatrix = startStage('matrix');
		yield* command(
			['bunx', '--no-install', 'playwright', 'test', '--config', 'playwright.ci.config.ts'],
			'Authenticated browser coverage failed (no auth artifacts retained)',
			env
		);
		finishMatrix();
		console.info('Authenticated CI: required browser coverage passed');
	}).pipe(
		Effect.ensuring(
			Effect.gen(function* () {
				const finishCleanup = startStage('cleanup');
				// Recovery intents live outside ephemeral credentials/storage and survive failures.
				const cleanup = yield* Effect.all([cleanupAccountRun(recovery), call('bootstrap:reset')], {
					mode: 'result',
					concurrency: 2
				});
				if (cleanup.some((result) => result._tag === 'Failure'))
					yield* Effect.fail(new CiFailure({ message: 'Authenticated CI cleanup failed' }));
				finishCleanup();
				console.info('Authenticated CI: cleanup passed');
			}).pipe(Effect.orDie)
		)
	);
});
const cancellation = new AbortController();
process.once('SIGINT', () => cancellation.abort());
process.once('SIGTERM', () => cancellation.abort());
Effect.runPromise(Effect.scoped(program), { signal: cancellation.signal }).catch(
	(error: unknown) => {
		console.error(
			error instanceof CiFailure ||
				error instanceof ProcessFailure ||
				error instanceof AccountResourceFailure
				? error.message
				: 'Authenticated CI failed'
		);
		process.exitCode = 1;
	}
);
