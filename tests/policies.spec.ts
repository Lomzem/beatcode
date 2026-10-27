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
	// Links inside policy text need a cue beyond color; axe accepts same-colored links.
	await page.getByText('Service policies and contact', { exact: true }).click();
	for (const name of ['Clerk', 'Beatcode repository'])
		await expect(page.getByRole('link', { name, exact: true })).toHaveCSS(
			'text-decoration-line',
			'underline'
		);
	await page.goto('/sign-in');
	await page.getByRole('link', { name: 'Privacy', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Privacy', exact: true })).toBeVisible();
});
