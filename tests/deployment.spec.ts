import { expect, test } from '@playwright/test';

test('the static app boots and navigates under its production security policy', async ({
	page
}) => {
	const violations: string[] = [];
	await page.addInitScript(() => {
		const events: string[] = [];
		Reflect.set(window, 'policyViolations', events);
		document.addEventListener('securitypolicyviolation', (event) => {
			events.push(event.violatedDirective);
		});
	});
	page.on('pageerror', (error) => violations.push(error.message));
	const response = await page.goto('/');
	expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
	await expect(page.getByRole('heading', { name: 'Rooms', exact: true })).toBeVisible();
	await page.getByRole('link', { name: 'Sign in to play' }).click();
	await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
	expect(await page.evaluate(() => Reflect.get(window, 'policyViolations'))).toEqual([]);
	expect(violations).toEqual([]);
});
