import { expect, test } from '@playwright/test';

test('public content and navigation arrive in the built HTML before JavaScript', async ({
	browser,
	viewport
}) => {
	const context = await browser.newContext({ javaScriptEnabled: false, viewport });
	const page = await context.newPage();
	for (const [path, heading] of [
		['/', 'Rooms'],
		['/sign-in', 'Sign in'],
		['/settings', 'Settings'],
		['/privacy', 'Privacy']
	]) {
		await page.goto(path);
		await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
		await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
		if (path === '/')
			await expect(page.getByRole('link', { name: 'Sign in to play' })).toBeVisible();
	}
	await context.close();
});

test.describe('cold rendering', () => {
	if (process.env.RENDERING_BASE_URL) test.use({ baseURL: process.env.RENDERING_BASE_URL });
	for (const path of ['/', '/sign-in']) {
		test(`${path} stays stable while fonts, JavaScript and account service settle`, async ({
			page
		}, testInfo) => {
			await page.route('**/*', async (route) => {
				const url = new URL(route.request().url());
				if (/\.(ttf|woff2)$/.test(url.pathname))
					await new Promise((resolve) => setTimeout(resolve, 1200));
				else if (url.pathname.includes('/entry/start'))
					await new Promise((resolve) => setTimeout(resolve, 1000));
				else if (url.hostname.includes('clerk'))
					await new Promise((resolve) => setTimeout(resolve, 1200));
				await route.continue();
			});
			await page.addInitScript(() => {
				type Shift = PerformanceEntry & {
					value: number;
					hadRecentInput: boolean;
					sources?: {
						node?: Element;
						previousRect: DOMRectReadOnly;
						currentRect: DOMRectReadOnly;
					}[];
				};
				const shifts: { at: number; value: number; nodes: unknown[] }[] = [];
				Reflect.set(window, 'renderingShifts', shifts);
				if (PerformanceObserver.supportedEntryTypes.includes('layout-shift')) {
					new PerformanceObserver((list) => {
						for (const entry of list.getEntries() as Shift[]) {
							if (!entry.hadRecentInput)
								shifts.push({
									at: entry.startTime,
									value: entry.value,
									nodes:
										entry.sources?.map((source) => ({
											tag: source.node?.tagName,
											id: source.node?.id,
											previous: source.previousRect,
											current: source.currentRect
										})) ?? []
								});
						}
					}).observe({ type: 'layout-shift', buffered: true });
				}
			});
			await page.goto(path);
			await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
			if (path === '/sign-in')
				await expect(page.getByText(/^Connecting(?:…| to the account service…)?$/)).toHaveCount(0, {
					timeout: 30000
				});
			await page.evaluate(() => document.fonts.ready);
			await page.waitForTimeout(1500);
			const result = await page.evaluate(() => ({
				supported: PerformanceObserver.supportedEntryTypes.includes('layout-shift'),
				shifts: Reflect.get(window, 'renderingShifts') as { value: number }[],
				paints: performance
					.getEntriesByType('paint')
					.map((entry) => ({ name: entry.name, at: entry.startTime })),
				overflow: document.documentElement.scrollWidth > innerWidth
			}));
			await testInfo.attach('rendering-measurements', {
				body: JSON.stringify(result, null, 2),
				contentType: 'application/json'
			});
			expect(result.overflow).toBe(false);
			// Firefox/WebKit exercise hydration/reflow; only Chromium exposes layout-shift entries.
			if (result.supported)
				expect(result.shifts.reduce((sum, shift) => sum + shift.value, 0)).toBeLessThan(0.01);
		});
	}
});

// Distinct routing risk: Cloudflare's index fallback must not hydrate Home at a private URL.
test('a direct private URL boots its own route through the static fallback', async ({ page }) => {
	await page.goto('/play');
	await expect(page.getByRole('heading', { name: 'Play', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Rooms', exact: true })).toHaveCount(0);
});

test('saved theme is applied before the public page paints under CSP', async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem('beatcode.theme', 'contrast'));
	// Hold hydration behind the first meaningful frame, while allowing the real head script.
	let release: () => void = () => {};
	const hydration = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route('**/*.js', async (route) => {
		await hydration;
		await route.continue();
	});
	try {
		await page.goto('/', { waitUntil: 'commit' });
		await expect(page.getByRole('heading', { name: 'Rooms', exact: true })).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('contrast');
	} finally {
		release();
	}
	await page.unrouteAll({ behavior: 'wait' });
});
