import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

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

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

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
