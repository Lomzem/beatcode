import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('private play explains unavailable setup without exposing unusable game controls', async ({
	page
}) => {
	await page.goto('/play');
	await expect(page.getByRole('heading', { name: 'Play', exact: true })).toBeVisible();
	await expect(page.getByRole('status')).toContainText('not configured');
	await expect(page.getByRole('button', { name: 'Create room', exact: true })).toHaveCount(0);
	expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('an invite survives reload and return from unavailable sign-in', async ({ page }) => {
	await page.goto('/join#room-example.invite-example');
	await expect(page.getByRole('heading', { name: 'Join room', exact: true })).toBeVisible();
	await page.getByRole('link', { name: 'Sign in to continue' }).click();
	await expect(page).toHaveURL(/\/sign-in/);
	await page.reload();
	await page.getByRole('link', { name: 'Return to invitation' }).click();
	await expect(page).toHaveURL(/\/join#room-example\.invite-example$/);
	await expect(page.getByRole('status')).toContainText('not configured');
});

test('room and match deep links provide an accessible recovery gate before authentication', async ({
	page
}) => {
	for (const [route, title] of [
		['/room/example', 'Room'],
		['/match/example', 'Match']
	]) {
		await page.goto(route);
		await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
		await expect(page.getByRole('status')).toContainText('not configured');
		expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
	}
});

test('missing invitations show a readable error under the device light palette', async ({
	page
}) => {
	await page.emulateMedia({ colorScheme: 'light' });
	await page.goto('/join');
	await expect(page.getByRole('alert')).toContainText('invitation is missing');
	expect(
		(await new AxeBuilder({ page }).withRules(['color-contrast']).analyze()).violations
	).toEqual([]);
});

test('game recovery and privacy reflow with enlarged text', async ({ page }) => {
	for (const route of ['/play', '/join', '/room/example', '/match/example', '/privacy']) {
		await page.goto(route);
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		await page.addStyleTag({
			content:
				'html {font-size:200%!important;} * {line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important;} p {margin-bottom:2em!important;}'
		});
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
			)
		).toBe(true);
		expect(
			(
				await new AxeBuilder({ page })
					.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
					.analyze()
			).violations
		).toEqual([]);
	}
});

test('a private sign-in return survives reload without session storage or token-bearing requests', async ({
	page
}) => {
	await page.addInitScript(() => {
		Object.defineProperty(window, 'sessionStorage', {
			get() {
				throw new DOMException('Storage disabled', 'SecurityError');
			}
		});
	});
	let exposed = false;
	page.on('request', (request) => {
		if (request.url().includes('private-invite-example')) exposed = true;
	});
	await page.goto(
		'/sign-in#next=' + encodeURIComponent('/join#room-example.private-invite-example')
	);
	await expect(page.getByRole('link', { name: 'Return to invitation' })).toBeVisible();
	await expect(page.getByRole('alert')).toContainText(
		'Your browser cannot save this invitation for the trip to sign-in'
	);
	await page.reload();
	await page.getByRole('link', { name: 'Return to invitation' }).click();
	await expect(page).toHaveURL(/\/join#room-example\.private-invite-example$/);
	expect(exposed).toBe(false);
});
