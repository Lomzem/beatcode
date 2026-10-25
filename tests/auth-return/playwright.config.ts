import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
	testDir: '.',
	testMatch: '*.browser.ts',
	workers: 1,
	forbidOnly: !!process.env.CI,
	reporter: process.env.CI ? 'github' : 'list',
	use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
	projects: [
		{ name: 'chromium', use: devices['Desktop Chrome'] },
		{ name: 'firefox', use: devices['Desktop Firefox'] },
		{ name: 'webkit', use: devices['Desktop Safari'] }
	],
	webServer: {
		cwd: '../..',
		command:
			'bun run build --config tests/auth-return/vite.config.ts && node scripts/ops/security-headers.mjs && node tests/static-server.mjs',
		env: {
			PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_auth_return_fixture',
			// Never contacted: the tests abort every non-local request and socket.
			PUBLIC_CONVEX_URL: 'https://auth-return-fixture.convex.cloud',
			PUBLIC_CLERK_OAUTH_PROVIDERS: ''
		},
		port: 4173,
		reuseExistingServer: false
	}
});
