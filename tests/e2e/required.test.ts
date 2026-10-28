import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { runInNewContext } from 'node:vm';

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

test('fast validation releases independent browser jobs without dropping or duplicating suites', () => {
	type Job = { needs?: string | string[]; if?: string; steps?: { run?: string }[] };
	const { jobs } = parse(readFileSync('.github/workflows/checks.yml', 'utf8')) as {
		jobs: Record<string, Job>;
	};
	const commands = (job: Job) => job.steps?.flatMap((step) => (step.run ? [step.run] : [])) ?? [];
	const fast = Object.entries(jobs).find(([, job]) =>
		commands(job).includes('bun run test:backend')
	);
	const browser = Object.entries(jobs).find(([, job]) =>
		commands(job).includes('bun run test:browser')
	);
	assert.ok(fast, 'Non-browser suites must have a fast validation job');
	assert.ok(browser, 'Public browser suites must have an independent job');
	assert.notEqual(fast[0], browser[0]);
	assert.ok(![...commands(fast[1]), ...commands(browser[1])].includes('bun run test'));
	assert.deepEqual([jobs.authenticated.needs].flat(), [fast[0]]);
	assert.deepEqual([browser[1].needs].flat(), [fast[0]]);
	const existing = JSON.parse(readFileSync('package.json', 'utf8'))
		.scripts.test.split(' && ')
		.sort();
	const scheduled = [...commands(fast[1]), ...commands(browser[1])]
		.filter((command) => existing.includes(command))
		.sort();
	assert.deepEqual(scheduled, existing, 'Every existing suite must execute exactly once');
	for (const harness of [
		'bun test tests/e2e/required.test.ts',
		'bunx --no-install vitest run --config tests/e2e/vitest.config.ts'
	])
		assert.ok(commands(fast[1]).includes(harness), 'Harness checks must precede hosted work');
});

test('aggregate and production gates reject failed, cancelled, missing or skipped required coverage', () => {
	type Job = {
		needs?: string[];
		if?: string;
		steps?: { env?: Record<string, string>; run?: string }[];
	};
	const checks = parse(readFileSync('.github/workflows/checks.yml', 'utf8')).jobs as Record<
		string,
		Job
	>;
	const gate = checks.checks.steps?.find((step) => step.env?.AUTHENTICATED_REQUIRED);
	assert.ok(gate?.run, 'The required checks job must aggregate all suite results');
	assert.equal(checks.checks.if, 'always()');
	assert.deepEqual(checks.checks.needs?.slice().sort(), ['authenticated', 'browser', 'validate']);
	const production = parse(readFileSync('.github/workflows/deploy.yml', 'utf8')).jobs;
	const productionGate = production['require-authenticated-ci'].steps.find(
		(step: { run?: string }) => step.run
	)?.run;
	assert.ok(productionGate);
	const output = parse(readFileSync('.github/workflows/checks.yml', 'utf8')).on.workflow_call
		.outputs['authenticated-result'].value;
	assert.equal(output, '${{ jobs.authenticated.result }}');
	const condition = gate.env!.AUTHENTICATED_REQUIRED.slice(3, -2).trim();
	for (const [repository, eventName, headRepo, expected] of [
		['Lomzem/beatcode', 'pull_request', 'Lomzem/beatcode', true],
		['Lomzem/beatcode', 'pull_request', 'someone/fork', false],
		['Lomzem/beatcode', 'push', undefined, true],
		['someone/fork', 'pull_request', 'someone/fork', false]
	] as const) {
		const github = {
			repository,
			event_name: eventName,
			event: headRepo ? { pull_request: { head: { repo: { full_name: headRepo } } } } : {}
		};
		// These workflow expressions deliberately use only the JS-compatible boolean subset.
		assert.equal(
			runInNewContext(checks.authenticated.if!, { github }, { timeout: 1000 }),
			expected
		);
		assert.equal(runInNewContext(condition, { github }, { timeout: 1000 }), expected);
	}
	for (const required of ['true', 'false', ''])
		for (const validation of ['success', 'failure', 'cancelled', 'skipped'])
			for (const browser of ['success', 'failure', 'cancelled', 'skipped'])
				for (const authenticated of ['success', 'failure', 'cancelled', 'skipped', '']) {
					const aggregateStatus: number | null = spawnSync('bash', ['-e', '-c', gate.run], {
						env: {
							PATH: process.env.PATH,
							VALIDATION_RESULT: validation,
							BROWSER_RESULT: browser,
							AUTHENTICATED_REQUIRED: required,
							AUTHENTICATED_RESULT: authenticated
						}
					}).status;
					const passed =
						validation === 'success' &&
						browser === 'success' &&
						(required === 'false' || (required === 'true' && authenticated === 'success'));
					assert.equal(
						aggregateStatus,
						passed ? 0 : 1,
						JSON.stringify({ required, validation, browser, authenticated })
					);
					const deployStatus = spawnSync('bash', ['-e', '-c', productionGate], {
						env: {
							PATH: process.env.PATH,
							CHECKS_RESULT: passed ? 'success' : 'failure',
							AUTHENTICATED_RESULT: authenticated
						}
					}).status;
					assert.equal(deployStatus, passed && authenticated === 'success' ? 0 : 1);
				}
});

test(
	'authenticated coverage requires every project/scenario once and preserves project case order',
	{ timeout: 60000 },
	() => {
		const folder = mkdtempSync(join(tmpdir(), 'beatcode-coverage-'));
		try {
			const playwright = resolve('node_modules/@playwright/test/index.mjs');
			const titles = [
				'two authenticated players create, join, ready, preserve code, and concede a match',
				'ready commits the displayed saved deck and locks editing until cancelled',
				'a real development account verifies email, persists its nickname, and recovers a private room',
				'strict compile reaches a scored verdict and round result through the authenticated UI'
			];
			const projects = ['chromium', 'firefox', 'webkit'].flatMap((browser) =>
				[320, 768, 1280].map((width) => ({ name: `${browser}-${width}` }))
			);
			const config = join(folder, 'playwright.config.mjs');
			const run = (body: string, selected = projects) => {
				writeFileSync(
					config,
					`export default {
				testDir: '.', outputDir: ${JSON.stringify(join(folder, 'results'))},
				fullyParallel: false, workers: 2, retries: 0, maxFailures: 1,
				projects: ${JSON.stringify(selected)},
				reporter: [[${JSON.stringify(resolve('tests/e2e/coverage-reporter.ts'))}]]
			};`
				);
				writeFileSync(
					join(folder, 'match-authenticated.spec.mjs'),
					`import { test } from ${JSON.stringify(playwright)}; ${body}`
				);
				return spawnSync(
					'node',
					[resolve('node_modules/@playwright/test/cli.js'), 'test', '--config', config],
					{
						env: { PATH: process.env.PATH },
						encoding: 'utf8',
						timeout: 30000
					}
				);
			};
			const cases = (names: string[]) =>
				names.map((title) => `test(${JSON.stringify(title)}, () => {});`).join('\n');
			const full = run(`let next = 0;
			${titles
				.map(
					(title, index) => `test(${JSON.stringify(title)}, async ({}, info) => {
				if (next++ !== ${index}) throw new Error('Project order lost');
				console.info('Fixture worker: ' + info.parallelIndex);
				await new Promise(resolve => setTimeout(resolve, 10));
			});`
				)
				.join('\n')}`);
			assert.equal(full.status, 0, full.stdout + full.stderr);
			assert.match(full.stdout, /Fixture worker: 0/);
			assert.match(full.stdout, /Fixture worker: 1/);
			assert.match(full.stdout, /36 passed, 0 failed\/skipped; required exact 36; complete/);
			assert.equal(
				(
					full.stdout.match(/CI timing: (chromium|firefox|webkit)-(320|768|1280) project \d+ms/g) ??
					[]
				).length,
				9
			);
			const interrupted = run(`
				import { mkdirSync, existsSync } from 'node:fs';
				test.beforeAll(async ({}, info) => {
					mkdirSync(${JSON.stringify(folder)} + '/' + info.project.name);
					console.info('Fixture setup: ' + info.project.name);
				});
				test(${JSON.stringify(titles[0])}, async ({}, info) => {
					const until = Date.now() + 5000;
					while (!existsSync(${JSON.stringify(folder)} + '/chromium-320') ||
						!existsSync(${JSON.stringify(folder)} + '/chromium-768')) {
						if (Date.now() > until) throw new Error('Second project did not start');
						await new Promise(resolve => setTimeout(resolve, 10));
					}
					if (info.project.name === 'chromium-320') throw new Error('Deliberate fixture failure');
					await new Promise(resolve => setTimeout(resolve, 10000));
				});
				${cases(titles.slice(1))}
			`);
			assert.equal(interrupted.status, 1, interrupted.stdout + interrupted.stderr);
			assert.match(interrupted.stdout, /CI case: chromium-320 failed/);
			assert.match(interrupted.stdout, /CI case: chromium-768 interrupted/);
			assert.match(interrupted.stdout, /required exact 36; incomplete/);
			assert.deepEqual(
				[...interrupted.stdout.matchAll(/Fixture setup: (\S+)/g)].map((match) => match[1]).sort(),
				['chromium-320', 'chromium-768']
			);
			for (const [body, selected] of [
				[cases(titles.slice(1)), projects],
				[cases(['replacement', ...titles.slice(1)]), projects],
				[cases(titles) + `test.describe('duplicate', () => { ${cases([titles[0]])} });`, projects],
				[cases(titles), projects.slice(1)],
				[cases(titles), [...projects, { name: 'unknown-project' }]],
				[`test.skip(${JSON.stringify(titles[0])}, () => {});` + cases(titles.slice(1)), projects],
				[
					"for (let i = 0; i < 36; i++) test('unrelated ' + i, () => {});",
					[{ name: 'chromium-320' }]
				]
			] as const) {
				const result = run(body, [...selected]);
				assert.equal(result.status, 1, result.stdout + result.stderr);
				assert.match(result.stdout, /required exact 36; incomplete/);
			}
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	}
);
