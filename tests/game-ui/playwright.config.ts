import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: '.',
	testMatch: '*.browser.ts',
	workers: 1,
	outputDir: '../../.scratch/competitive-leetcode/game-ui-results',
	use: { baseURL: 'http://127.0.0.1:4188', serviceWorkers: 'block', trace: 'retain-on-failure' },
	projects: (['chromium', 'firefox', 'webkit'] as const).flatMap((browserName) =>
		[320, 1280].map((width) => ({
			name: `${browserName}-${width}`,
			use: { browserName, viewport: { width, height: 640 } }
		}))
	),
	webServer: {
		command: 'node ../../node_modules/vite/bin/vite.js --config vite.config.ts',
		port: 4188,
		reuseExistingServer: false
	}
});
