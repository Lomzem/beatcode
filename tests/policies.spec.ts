import { expect, test } from '@playwright/test';

test('a visitor can read how sign-in and submitted code are handled before signing in', async ({
	page
}) => {
	await page.goto('/privacy');
	await expect(page.getByRole('heading', { name: 'Privacy', exact: true })).toBeVisible();
	await expect(
		page.getByRole('heading', { name: 'Sign-in information', exact: true })
	).toBeVisible();
	await expect(
		page.getByRole('heading', { name: 'Code and match data', exact: true })
	).toBeVisible();
	await page.goto('/sign-in');
	await page.getByRole('link', { name: 'Privacy', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Privacy', exact: true })).toBeVisible();
});
