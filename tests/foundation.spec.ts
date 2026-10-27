import { expect, test } from '@playwright/test';

test('a visitor can reach sign-in and understands when it is unavailable', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('link', { name: 'Sign in to play' }).click();
	await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
	await expect(page.getByRole('status')).toContainText('Sign-in is not configured');
	await expect(page.getByRole('textbox', { name: 'Email address' })).toHaveCount(0);
});

test('a visitor can choose accessible preferences and keep them after reload', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	// A transition added by the test; only the Motion preference should remove it.
	const transition = () =>
		page.evaluate(() => {
			const probe = document.body.appendChild(document.createElement('span'));
			probe.style.transition = 'opacity 200ms';
			const duration = getComputedStyle(probe).transitionDuration;
			probe.remove();
			return duration;
		});
	await page.goto('/settings');
	expect(await transition()).toBe('0.2s');
	const status = page.getByRole('status');
	await page.getByRole('combobox', { name: 'Appearance', exact: true }).click();
	await page.getByRole('option', { name: 'High contrast', exact: true }).click();
	await expect(status).toContainText('High contrast');
	await page.getByRole('combobox', { name: 'Motion', exact: true }).click();
	await page.getByRole('option', { name: 'Reduce motion', exact: true }).click();
	await expect(status).toContainText('Reduce motion');
	await page.reload();
	await expect(page.getByRole('combobox', { name: 'Appearance', exact: true })).toContainText(
		'High contrast'
	);
	await expect(page.getByRole('combobox', { name: 'Motion', exact: true })).toContainText(
		'Reduce motion'
	);
	await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
	await page.getByRole('link', { name: 'Overview', exact: true }).click();
	await expect(page.getByRole('link', { name: 'Sign in to play' })).toBeVisible();
	expect(await transition()).toBe('0s');
});

test('a device request for more contrast applies until the visitor chooses a theme', async ({
	page
}) => {
	await page.emulateMedia({ colorScheme: 'light', contrast: 'more' });
	await page.goto('/settings');
	await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
	await page.getByRole('combobox', { name: 'Appearance', exact: true }).click();
	await page.getByRole('option', { name: 'Light', exact: true }).click();
	await page.reload();
	await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(244, 247, 255)');
});

import AxeBuilder from '@axe-core/playwright';

test('public routes remain accessible and reflow with enlarged, spaced text', async ({ page }) => {
	test.setTimeout(90_000);
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	for (const theme of ['light', 'dark', 'contrast']) {
		await page.goto('/settings');
		await page.getByRole('combobox', { name: 'Appearance', exact: true }).click();
		await page
			.getByRole('option', {
				name: { light: 'Light', dark: 'Dark', contrast: 'High contrast' }[theme],
				exact: true
			})
			.click();
		for (const route of ['/', '/sign-in', '/settings', '/sso-callback', '/privacy']) {
			await page.goto(route);
			await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
			await expect(page).toHaveTitle(/Beatcode/);
			await page.addStyleTag({
				content:
					'html { font-size: 200% !important; } * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }'
			});
			await page.evaluate(async () => {
				await document.fonts.ready;
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
				);
			});
			const layout = await page.evaluate(() => ({
				width: document.documentElement.clientWidth,
				content: document.documentElement.scrollWidth,
				overflow: [...document.querySelectorAll('body *')]
					.map((e) => ({
						tag: e.tagName,
						cls: e.getAttribute('class'),
						text: e.textContent?.slice(0, 30),
						x: e.getBoundingClientRect().x,
						w: e.getBoundingClientRect().width
					}))
					.filter((e) => e.x + e.w > innerWidth + 1)
			}));
			expect(
				layout.content,
				`${route} must reflow without page-level horizontal scrolling: ${JSON.stringify(layout.overflow)}`
			).toBeLessThanOrEqual(layout.width + 1);
			const results = await new AxeBuilder({ page })
				.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
				.analyze();
			expect(results.violations, `${route} accessibility violations`).toEqual([]);
		}
	}
	expect(errors).toEqual([]);
});

test('keyboard users can skip navigation and reach settings', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await page.keyboard.press('Tab');
	await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('main')).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await page.keyboard.press('Shift+Tab');
	await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
	await page.keyboard.press('Tab');
	await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('main')).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(page.getByLabel('Appearance')).toBeFocused();
});

// Public browser seam: optional rules stay out of the way until requested.
test('a visitor can reveal and dismiss match rules with the keyboard', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('link', { name: 'Sign in to play' })).toBeVisible();
	const rule = page.getByText('Best of three, 10 minutes per round', { exact: true });
	await expect(rule).toBeHidden();
	const disclosure = page.getByText('Match rules', { exact: true });
	await disclosure.focus();
	await page.keyboard.press('Enter');
	await expect(rule).toBeVisible();
	await page.keyboard.press('Space');
	await expect(rule).toBeHidden();
});
