import { defineConfig } from '@playwright/test';
export default defineConfig({
	testDir: '.',
	testMatch: '*.browser.ts',
	workers: 1,
	outputDir: '../../.scratch/competitive-leetcode/primitives-r1-results',
	use: { baseURL: 'http://127.0.0.1:4187', trace: 'retain-on-failure' },
	projects: (['chromium', 'firefox', 'webkit'] as const).flatMap((browserName) =>
		[320, 1280].map((width) => ({
			name: `${browserName}-${width}`,
			use: { browserName, viewport: { width, height: 640 } }
		}))
	),
	webServer: {
		command: 'node ../../node_modules/vite/bin/vite.js --config vite.config.ts',
		port: 4187,
		reuseExistingServer: false,
		env: {
			PUBLIC_CONVEX_URL: '',
			PUBLIC_CLERK_PUBLISHABLE_KEY: '',
			PUBLIC_CLERK_OAUTH_PROVIDERS: ''
		}
	}
});
