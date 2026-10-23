import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
	testDir: './tests',
	testMatch: '**/*.spec.ts',
	fullyParallel: true,
	workers: 4,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	reporter: process.env.CI ? 'github' : 'list',
	use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
	projects: ['chromium', 'firefox', 'webkit'].flatMap((browserName) =>
		[320, 768, 1280].map((width) => ({
			name: `${browserName}-${width}`,
			use: {
				...devices[
					browserName === 'chromium'
						? 'Desktop Chrome'
						: browserName === 'firefox'
							? 'Desktop Firefox'
							: 'Desktop Safari'
				],
				viewport: { width, height: width === 320 ? 640 : width === 768 ? 1024 : 800 }
			}
		}))
	),
	webServer: {
		command:
			'bun run build && PUBLIC_CONVEX_URL=https://careful-greyhound-596.convex.cloud node scripts/ops/security-headers.mjs && node tests/static-server.mjs',
		env: {
			PUBLIC_CLERK_PUBLISHABLE_KEY: '',
			PUBLIC_CONVEX_URL: '',
			PUBLIC_CLERK_OAUTH_PROVIDERS: ''
		},
		port: 4173,
		reuseExistingServer: false
	}
});
