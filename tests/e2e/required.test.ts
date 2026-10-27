import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

test('required authenticated CI refuses absent configuration before deploying or launching browsers', () => {
	const result = spawnSync('bun', ['tests/e2e/run.ts', '--validate'], {
		env: { PATH: process.env.PATH },
		encoding: 'utf8'
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Authenticated CI configuration missing/);
	assert.doesNotMatch(result.stdout, /skipped/);
});

test('required authenticated CI refuses production and nonmatching development keys', () => {
	for (const key of ['prod:unsafe|private', 'dev:another-deployment|private']) {
		const result = spawnSync('bun', ['tests/e2e/run.ts', '--validate'], {
			env: {
				PATH: process.env.PATH,
				CONVEX_CI_DEPLOY_KEY: key,
				PUBLIC_CONVEX_URL: 'https://warmhearted-avocet-538.convex.cloud',
				CLERK_CI_SECRET_KEY: 'sk_test_private',
				PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_public',
				CLERK_JWT_ISSUER_DOMAIN: 'https://test.clerk.accounts.dev'
			},
			encoding: 'utf8'
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /requires isolated DEV credentials/);
		assert.doesNotMatch(result.stderr, /private/);
	}
});

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('the production workflow passes isolated credentials through reusable authenticated CI', () => {
	type Job = {
		uses?: string;
		secrets?: Record<string, string> | 'inherit';
		environment?: string | { name: string };
		steps?: { env?: Record<string, string> }[];
	};
	type Workflow = {
		on: { workflow_call: { secrets?: Record<string, { required?: boolean }> } };
		jobs: Record<string, Job>;
	};
	const workflow = (path: string) => parse(readFileSync(path, 'utf8')) as Workflow;
	const caller = Object.values(workflow('.github/workflows/deploy.yml').jobs).find(
		(job) => job.uses === './.github/workflows/checks.yml'
	);
	assert.ok(caller);
	assert.notEqual(caller.secrets, 'inherit', 'production credentials must stay outside called CI');
	const callee = workflow('.github/workflows/checks.yml');
	const job = Object.values(callee.jobs).find((job) =>
		job.steps?.some((step) => step.env?.CLERK_CI_SECRET_KEY)
	);
	assert.ok(job);
	const step = job.steps?.find((step) => step.env?.CLERK_CI_SECRET_KEY);
	assert.ok(step?.env);
	const secrets: Record<string, string> = {};
	const environments: Record<string, Record<string, string>> = {
		ci: {
			CONVEX_CI_DEPLOY_KEY: 'dev:warmhearted-avocet-538|ci-fixture',
			CLERK_CI_SECRET_KEY: 'sk_test_ci-fixture'
		},
		production: {
			CONVEX_DEPLOY_KEY: 'prod:careful-greyhound-596|do-not-forward',
			CLOUDFLARE_API_TOKEN: 'do-not-forward'
		}
	};
	const vars: Record<string, string> = {
		CONVEX_CI_URL: 'https://warmhearted-avocet-538.convex.cloud',
		CLERK_PUBLISHABLE_KEY_DEV: 'pk_test_ci-fixture',
		CLERK_JWT_ISSUER_DOMAIN_DEV: 'https://test.clerk.accounts.dev'
	};
	// GitHub requires named secret inputs even for environment-only secrets. The called
	// job's environment supplies their values; the caller has no repository-level copies.
	// Model these direct references, then exercise the actual CI configuration guard.
	const evaluate = (value: string, context: { secrets: Record<string, string> }) => {
		const match = /^\$\{\{\s*(secrets|vars)\.([A-Z_]+)\s*\}\}$/.exec(value);
		return match ? ((match[1] === 'vars' ? vars : context.secrets)[match[2]] ?? '') : value;
	};
	const forwarded = Object.fromEntries(
		Object.entries(caller.secrets ?? {}).map(([key, value]) => [key, evaluate(value, { secrets })])
	);
	const environmentName =
		typeof job.environment === 'string' ? job.environment : job.environment?.name;
	const scopedSecrets = Object.fromEntries(
		Object.entries(forwarded).map(([key, value]) => [
			key,
			environments[environmentName ?? '']?.[key] ?? value
		])
	);
	const result = spawnSync('bun', ['tests/e2e/run.ts', '--validate'], {
		env: {
			PATH: process.env.PATH,
			...Object.fromEntries(
				Object.entries(step.env).map(([key, value]) => [
					key,
					evaluate(value, { secrets: scopedSecrets })
				])
			)
		},
		encoding: 'utf8'
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(Object.keys(forwarded).sort(), ['CLERK_CI_SECRET_KEY', 'CONVEX_CI_DEPLOY_KEY']);
	for (const name of Object.keys(forwarded)) {
		assert.equal(callee.on.workflow_call.secrets?.[name]?.required, true);
	}
});

test('the authenticated coverage process fails when selected cases skip or coverage shrinks', () => {
	const folder = mkdtempSync(join(tmpdir(), 'beatcode-coverage-'));
	try {
		const playwright = resolve('node_modules/@playwright/test/index.mjs');
		writeFileSync(
			join(folder, 'playwright.config.mjs'),
			`export default { testDir: '.', reporter: [[${JSON.stringify(resolve('tests/e2e/coverage-reporter.ts'))}]] };`
		);
		for (const [body, expected] of [
			["test.skip('auth', () => {});", 1],
			["test('auth', () => {});", 1],
			["for (let i = 0; i < 36; i++) test('auth ' + i, () => {});", 0]
		] as const) {
			writeFileSync(
				join(folder, 'coverage.spec.mjs'),
				`import { test } from ${JSON.stringify(playwright)}; ${body}`
			);
			const result = spawnSync(
				'node',
				[
					resolve('node_modules/@playwright/test/cli.js'),
					'test',
					'--config',
					join(folder, 'playwright.config.mjs')
				],
				{
					env: { PATH: process.env.PATH },
					encoding: 'utf8'
				}
			);
			assert.equal(result.status, expected);
			assert.match(result.stdout, /required minimum 36/);
		}
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});
