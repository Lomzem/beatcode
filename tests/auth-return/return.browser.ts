import { expect, test, type Page } from '@playwright/test';

const invite = 'room123.private-invite-token';
let exposed: string[] = [];

test.beforeEach(async ({ context }) => {
	exposed = [];
	await context.route('**/*', (route) => {
		const url = new URL(route.request().url());
		if (url.href.includes('private-invite-token')) exposed.push(url.href);
		return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
	});
	await context.routeWebSocket(/.*/, (socket) => socket.close());
});
test.afterEach(() => expect(exposed).toEqual([]));

async function signInFrom(page: Page, path: string) {
	await page.goto(path);
	await page.getByRole('link', { name: 'Sign in to continue' }).click();
	await expect(page).toHaveURL(/\/sign-in#next=/);
	await page.getByRole('button', { name: 'Continue with Clerk' }).click();
}
// Clerk receives only the bare callback; HTTP interception cannot see a fragment leak.
async function expectRedirectOptions(page: Page, hash = '') {
	const recorded = await page.evaluate(() => localStorage.getItem('auth-return-fixture.redirect'));
	const callback = new URL('/sign-in' + hash, page.url()).href;
	expect(JSON.parse(recorded ?? 'null')).toEqual({
		redirectUrl: callback,
		signInForceRedirectUrl: callback,
		signUpForceRedirectUrl: callback
	});
}
async function openAccount(page: Page) {
	await page.getByRole('link', { name: 'Account', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'You’re signed in' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
	await expect(page).toHaveURL(/\/sign-in$/);
}

for (const [path, heading] of [
	['/play', 'Play'],
	['/room/k57abc_D-9', 'Room'],
	['/match/k57abc_D-9', 'Match']
] as const)
	test(`signing in from ${path} returns there once, then Account stays on account`, async ({
		page
	}) => {
		await signInFrom(page, path);
		await expect(page).toHaveURL(new RegExp(`${path}$`));
		await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
		await expectRedirectOptions(page);
		await openAccount(page);
	});

test('a returned invitation is consumed, so Account no longer bounces to it', async ({ page }) => {
	await signInFrom(page, `/join#${invite}`);
	await expect(page).toHaveURL(new RegExp(`/join#${invite.replace('.', '\\.')}$`));
	await expectRedirectOptions(page);
	await openAccount(page);
});

test('an invitation without its fragment is not saved, so a later sign-in opens Account', async ({
	page
}) => {
	await page.goto('/join');
	await expect(page.getByRole('alert')).toContainText('missing its room and token');
	await page.getByRole('link', { name: 'Sign in', exact: true }).click();
	await page.getByRole('button', { name: 'Continue with Clerk' }).click();
	await expect(page.getByRole('heading', { name: 'You’re signed in' })).toBeVisible();
	await expect(page).toHaveURL(/\/sign-in$/);
	await expectRedirectOptions(page);
});

test('without session storage, a manual return keeps the signed-in visitor on Account', async ({
	page
}) => {
	await page.addInitScript(() => {
		Object.defineProperty(window, 'sessionStorage', {
			get() {
				throw new DOMException('Storage disabled', 'SecurityError');
			}
		});
	});
	await page.goto(`/join#${invite}`);
	await page.getByRole('link', { name: 'Sign in to continue' }).click();
	await expect(page.getByRole('alert')).toContainText('cannot save this invitation');
	await page.getByRole('button', { name: 'Continue without automatic return' }).click();
	await expect(page.getByRole('status')).toHaveText(
		'Reopen your invitation link to join its room.'
	);
	await expect(page).toHaveURL(/\/sign-in#return=manual$/);
	await expectRedirectOptions(page, '#return=manual');
	await openAccount(page);
});

test('a signed-in visitor who abandons an invitation can still open Account', async ({ page }) => {
	await page.goto('/');
	await page.evaluate(() => localStorage.setItem('auth-return-fixture.session', '1'));
	await page.goto(`/join#${invite}`);
	await expect(page.getByRole('heading', { name: 'Join room', exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Account', exact: true })).toBeVisible();
	await openAccount(page);
});
