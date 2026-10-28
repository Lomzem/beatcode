import { defineConfig } from '@playwright/test';
import publicConfig from './playwright.config';

if (
	process.env.MATCH_E2E_REQUIRED !== '1' ||
	!process.env.MATCH_E2E_PRIVATE_DIR ||
	!process.env.MATCH_E2E_URL
)
	throw new Error('Use bun tests/e2e/run.ts for required authenticated coverage');

export default defineConfig({
	...publicConfig,
	testMatch: '**/match-authenticated.spec.ts',
	fullyParallel: false,
	// Projects own separate accounts; keep scenarios within each project sequential.
	workers: 2,
	retries: 0,
	maxFailures: 1,
	timeout: 180000,
	expect: { timeout: 20000 },
	reporter: [['./tests/e2e/coverage-reporter.ts']],
	outputDir: `${process.env.MATCH_E2E_PRIVATE_DIR}/results`,
	use: { baseURL: process.env.MATCH_E2E_URL, trace: 'off', video: 'off', screenshot: 'off' },
	webServer: {
		command: 'node tests/static-server.mjs',
		url: process.env.MATCH_E2E_URL,
		reuseExistingServer: false
	}
});
