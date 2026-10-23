import { test, expect, type Locator } from '@playwright/test';
import { readFile, chmod, appendFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { join } from 'node:path';
import { hostedSignIn, activate, choose } from './e2e/accounts';
import setupAccounts from './e2e/setup';
import { observeCards, cardFailureLine } from './e2e/card-diagnostics';
import { observeScoredResult } from './e2e/results';
import { observePresence, expectPresenceCadence, expectPresenceStopped } from './e2e/presence';

// Real-account sessions must not be recorded in traces or videos.
test.use({ trace: 'off', video: 'off' });

// Read the painted selection, including syntax tokens, rather than theme constants.
async function selectionContrast(editor: Locator) {
	return editor.evaluate((content) => {
		function luminance(color: string) {
			const channels = color
				.match(/[\d.]+/g)!
				.slice(0, 3)
				.map(Number);
			return channels.reduce((sum, channel, index) => {
				const value = channel / 255;
				return (
					sum +
					(value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) *
						[0.2126, 0.7152, 0.0722][index]
				);
			}, 0);
		}
		function ratio(a: string, b: string) {
			const x = luminance(a),
				y = luminance(b);
			return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
		}
		const range = window.getSelection()?.getRangeAt(0);
		if (!range || range.collapsed) throw new Error('Expected keyboard-selected source');
		const editorRoot = content.closest('.cm-editor')!;
		const selection = editorRoot.querySelector('.cm-selectionBackground');
		if (!selection) throw new Error('Expected a painted editor selection');
		const background = getComputedStyle(selection).backgroundColor;
		const canvas = getComputedStyle(editorRoot).backgroundColor;
		const text = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
		const ratios: number[] = [];
		while (text.nextNode()) {
			if (text.currentNode.textContent?.trim() && range.intersectsNode(text.currentNode)) {
				const element = text.currentNode.parentElement!;
				ratios.push(ratio(getComputedStyle(element, '::selection').color, background));
			}
		}
		if (!ratios.length) throw new Error('Expected selected source text');
		return { text: Math.min(...ratios), boundary: ratio(background, canvas) };
	});
}

// Real Clerk browser storage from two dev accounts; no authentication mocks.
const sumSource =
	'#include <iostream>\nint main() { long long a, b; std::cin >> a >> b; std::cout << a + b << "\\n"; }';
const target = process.env.MATCH_E2E_URL;
let hostState = process.env.MATCH_E2E_HOST_STATE;
let guestState = process.env.MATCH_E2E_GUEST_STATE;
const required = process.env.MATCH_E2E_REQUIRED === '1';
if (required && (!target || !process.env.MATCH_E2E_PRIVATE_DIR))
	throw new Error('Required authenticated coverage has no configuration');
test.beforeAll(async ({ browserName }, testInfo) => {
	if (required && browserName) await setupAccounts({ projects: [testInfo.project] });
});
test.beforeEach(async ({ browserName }, testInfo) => {
	if (required) {
		if (!browserName) throw new Error('Authenticated browser missing');
		hostState = join(process.env.MATCH_E2E_PRIVATE_DIR!, testInfo.project.name, 'host.json');
		guestState = join(process.env.MATCH_E2E_PRIVATE_DIR!, testInfo.project.name, 'guest.json');
	}
});
async function panel(page: import('@playwright/test').Page, name: string) {
	await expect(page.getByRole('heading', { name: 'Active effects', exact: true })).toBeVisible();
	const tab = page.getByRole('tab', { name, exact: true });
	if (await tab.isVisible()) await activate(tab);
}
test('two authenticated players create, join, ready, preserve code, and concede a match', async ({
	browser
}, testInfo) => {
	test.skip(
		!required && (!target || !hostState || !guestState),
		'Requires MATCH_E2E_URL and two real Clerk storageState files; calibrated public backend must be deployed.'
	);
	test.setTimeout(240000);
	const host = await browser.newContext({
		storageState: hostState!,
		viewport: testInfo.project.use.viewport
	});
	const guest = await browser.newContext({
		storageState: guestState!,
		viewport: testInfo.project.use.viewport
	});
	try {
		const a = await host.newPage(),
			b = await guest.newPage();
		const presence = observePresence(a);
		const cardProbes = new Map([
			[a, observeCards(a)],
			[b, observeCards(b)]
		]);
		await a.goto(target! + '/play');
		await expect(a.getByRole('button', { name: 'Create room', exact: true })).toBeEnabled();
		await activate(a.getByRole('button', { name: 'Create room', exact: true }));
		const invitation = await a.getByLabel('Invitation link').inputValue();
		await b.goto(invitation);
		await activate(b.getByRole('button', { name: 'Join room', exact: true }));
		await expectPresenceCadence(a, presence);
		for (const p of [a, b]) {
			for (const name of ['Light mode', 'No paste', 'No hints', 'Brain teaser'])
				await choose(p.getByRole('checkbox', { name: new RegExp(name) }));
			await activate(p.getByRole('button', { name: 'Save deck', exact: true }));
			await activate(p.getByRole('button', { name: 'Ready', exact: true }));
			await expect(p.getByRole('button', { name: 'Cancel ready', exact: true })).toBeVisible();
		}
		await expect(a).toHaveURL(/\/match\//);
		await expect(b).toHaveURL(/\/match\//);
		await panel(a, 'Code');
		const editor = a.getByRole('textbox', { name: 'C++ solution', exact: true });
		await editor.fill('// reload recovery\n' + sumSource);
		await a.reload();
		await panel(a, 'Code');
		await expect(editor).toContainText('// reload recovery');
		// The actual Match editor owns selection readability; no mocked auth/editor state.
		for (const appearance of [
			'light',
			'dark',
			'contrast',
			'system-light',
			'system-dark',
			'forced-light',
			'forced-dark'
		]) {
			await a.emulateMedia({
				colorScheme: appearance.endsWith('light') ? 'light' : 'dark',
				forcedColors: appearance.startsWith('forced-') ? 'active' : 'none'
			});
			await a.evaluate((theme) => {
				if (theme.startsWith('system-') || theme.startsWith('forced-'))
					delete document.documentElement.dataset.theme;
				else document.documentElement.dataset.theme = theme;
			}, appearance);
			await editor.focus();
			await a.keyboard.press('ControlOrMeta+Home');
			await a.keyboard.press('ControlOrMeta+A');
			await expect(async () => {
				const contrast = await selectionContrast(editor);
				expect(contrast.text, `${appearance}: selected text contrast`).toBeGreaterThanOrEqual(4.5);
				expect(
					contrast.boundary,
					`${appearance}: selection boundary contrast`
				).toBeGreaterThanOrEqual(3);
			}).toPass({ timeout: 5000 });
		}
		await a.emulateMedia({ colorScheme: 'dark', forcedColors: 'none' });
		await a.evaluate(() => delete document.documentElement.dataset.theme);
		await expect(editor).toContainText('// reload recovery');
		await editor.focus();
		// End the contrast probe's select-all state before testing ordinary Tab escape.
		await a.keyboard.press('ArrowRight');
		await a.keyboard.press('Escape');
		await a.keyboard.press('Tab');
		await expect(editor).not.toBeFocused();
		await activate(a.getByRole('button', { name: 'Run samples', exact: true }));
		await panel(a, 'Results');
		await expect(a.getByText('Sample run done', { exact: true })).toBeVisible();
		await expect(a.getByText('Sample 1: AC', { exact: true })).toBeVisible();
		expect((await new AxeBuilder({ page: a }).analyze()).violations).toEqual([]);
		// Each chosen effect is sent and received through the real card UI.
		for (const name of ['Light mode', 'No paste', 'No hints', 'Brain teaser'] as const) {
			for (const [source, receiver] of [
				[a, b],
				[b, a]
			]) {
				await panel(source, 'Cards');
				const card = source.getByRole('button', { name: new RegExp('^' + name + ' ·') });
				await expect(card).toBeEnabled({ timeout: 65000 });
				cardProbes.get(source)!.begin();
				await activate(card);
				const incoming = receiver
					.getByRole('listitem')
					.filter({ hasText: new RegExp('^' + name + ' on you ·') });
				try {
					await expect(incoming).toBeVisible();
				} catch (error) {
					try {
						const count = await incoming.count().catch(() => -1);
						const visible = await incoming.isVisible().catch(() => false);
						console.info(
							cardFailureLine(
								name,
								source === a ? 'host-to-guest' : 'guest-to-host',
								cardProbes.get(source)!.read(name),
								cardProbes.get(receiver)!.read(name),
								count,
								visible
							)
						);
					} catch {
						/* Diagnostic failures must preserve the original assertion error. */
					}
					throw error;
				}
				await panel(receiver, 'Code');
				const code = receiver.getByRole('textbox', { name: 'C++ solution', exact: true });
				await code.focus();
				await receiver.keyboard.press('ArrowRight');
				await expect(code).toBeFocused();
				if (name === 'Light mode') {
					await expect(receiver.locator('html')).toHaveAttribute('data-theme', 'light');
				}
				if (name === 'No paste') {
					const before = await code.innerText();
					await code.evaluate((element) => {
						const data = new DataTransfer();
						data.setData('text/plain', 'PASTE MUST NOT ENTER THE SOLUTION');
						element.dispatchEvent(
							new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
						);
					});
					await expect(receiver.getByRole('status')).toContainText('Paste blocked by No paste.');
					await expect(code).toHaveText(before, { useInnerText: true });
				}
				if (name === 'No hints') {
					await code.fill('int fixtureValue');
					await code.press('End');
					await receiver.keyboard.type('(');
					await expect(code).toHaveText('int fixtureValue(');
				}

				if (name === 'Brain teaser') {
					await expect(
						receiver.getByRole('button', { name: 'Submit solution', exact: true })
					).toBeDisabled();
					const input = receiver.getByRole('spinbutton', { name: /^What is/ });
					const label = await input.evaluate(
						(element: HTMLInputElement) => element.labels?.[0].textContent ?? ''
					);
					const numbers = label.match(/\d+/g)!.map(Number);
					await input.fill(String(numbers[0] + numbers[1]));
					await activate(receiver.getByRole('button', { name: 'Check answer', exact: true }));
					await expect(input).not.toBeVisible();
				}
				expect((await new AxeBuilder({ page: receiver }).analyze()).violations).toEqual([]);
			}
		}
		await activate(a.getByRole('button', { name: 'Concede match', exact: true }));
		await activate(a.getByRole('button', { name: 'Confirm concede', exact: true }));
		await expect(a.getByRole('heading', { name: 'Match result', exact: true })).toBeVisible();
		await expect(b.getByRole('heading', { name: 'Match result', exact: true })).toBeVisible();
		await activate(a.getByRole('link', { name: 'Rooms', exact: true }));
		await expect(a).toHaveURL(/\/play$/);
		await expectPresenceStopped(a, presence);
	} finally {
		await host.close();
		await guest.close();
	}
});

test('ready commits the displayed saved deck and locks editing until cancelled', async ({
	browser
}, testInfo) => {
	test.skip(
		!required && (!target || !hostState || !guestState),
		'Requires two real Clerk sessions and the public development service.'
	);
	test.setTimeout(90000);
	const host = await browser.newContext({
		storageState: hostState!,
		viewport: testInfo.project.use.viewport
	});
	const guest = await browser.newContext({
		storageState: guestState!,
		viewport: testInfo.project.use.viewport
	});
	const started = Date.now();
	const mark = (stage: string) =>
		console.info(`Lobby ${testInfo.project.name}: ${stage} (${Date.now() - started}ms)`);
	const a = await host.newPage(),
		b = await guest.newPage();
	const guestPresence = observePresence(b);
	a.setDefaultTimeout(20000);
	b.setDefaultTimeout(20000);
	let pageErrors = 0;
	let consoleErrors = 0;
	a.on('pageerror', () => pageErrors++);
	a.on('console', (message) => {
		if (message.type() === 'error') consoleErrors++;
	});
	try {
		await a.goto(target! + '/play');
		await activate(a.getByRole('button', { name: 'Create room', exact: true }));
		await expect(a).toHaveURL(/\/room\//, { timeout: 20000 });
		if (process.env.MATCH_E2E_ROOM_RECEIPTS)
			await appendFile(
				process.env.MATCH_E2E_ROOM_RECEIPTS,
				new URL(a.url()).pathname.split('/').at(-1)! + '\n',
				{ mode: 0o600 }
			);
		mark('room created');
		await b.goto(await a.getByLabel('Invitation link').inputValue());
		await activate(b.getByRole('button', { name: 'Join room', exact: true }));
		const ready = a.getByRole('button', { name: 'Ready', exact: true });
		for (const name of ['Light mode', 'No paste', 'No hints', 'Brain teaser'])
			await choose(a.getByRole('checkbox', { name: new RegExp(name) }));
		await activate(a.getByRole('button', { name: 'Save deck', exact: true }));
		await expect(ready).toBeEnabled({ timeout: 20000 });
		await choose(a.getByRole('checkbox', { name: /Brain teaser/ }), false);
		await choose(a.getByRole('checkbox', { name: /Strict compile/ }));
		await expect(a.getByText(/^Reconnecting…/)).not.toBeVisible({ timeout: 20000 });
		await expect(ready).toBeDisabled();
		await expect(a.getByText('Unsaved deck changes', { exact: true })).toBeVisible();
		await activate(a.getByRole('button', { name: 'Save deck', exact: true }));
		await expect(a.getByText('Deck saved', { exact: true })).toBeVisible({ timeout: 20000 });
		await activate(ready);
		mark('ready requested');
		await expect(
			a.getByRole('group', { name: 'Choose exactly four cards' }).getByRole('checkbox')
		).toHaveCount(5);
		for (const checkbox of await a
			.getByRole('group', { name: 'Choose exactly four cards' })
			.getByRole('checkbox')
			.all())
			await expect(checkbox).toBeDisabled();
		await activate(a.getByRole('button', { name: 'Cancel ready', exact: true }));
		await expect(ready).toBeVisible({ timeout: 20000 });
		await expect(a.getByRole('checkbox', { name: /Strict compile/ })).toBeEnabled({
			timeout: 20000
		});
		mark('cancel acknowledged and editing enabled');
		await choose(a.getByRole('checkbox', { name: /Light mode/ }), false);
		await expect(ready).toBeDisabled();
		// Re-adding the first choice moves it to the end of the selection order.
		await choose(a.getByRole('checkbox', { name: /Light mode/ }));
		await expect(ready).toBeEnabled({ timeout: 20000 });
		await expect(a.getByText('Deck saved', { exact: true })).toBeVisible({ timeout: 20000 });
		expect((await new AxeBuilder({ page: a }).analyze()).violations).toEqual([]);
		mark('all behavior and axe assertions passed');
		await activate(a.getByText('Close room', { exact: true }));
		await choose(a.getByLabel('I understand'));
		await activate(a.getByRole('button', { name: 'Confirm close', exact: true }));
		await expect(a).toHaveURL(/\/play$/);
		await expect(b.getByText(/This room is closed/)).toBeVisible({ timeout: 20000 });
		mark('room closure acknowledged by both players');
		await expectPresenceStopped(b, guestPresence);
	} catch (error) {
		// Only fixed public-state flags leave the real-account page; never log URLs or HTML.
		const state = await a
			.evaluate(() => {
				const text = document.body.textContent ?? '';
				const buttons = [...document.querySelectorAll('button')];
				const cancel = buttons.find((button) => button.textContent?.trim() === 'Cancel ready');
				return {
					reconnecting: text.includes('Reconnecting…'),
					cancelVisible: !!cancel,
					cancelDisabled: cancel?.disabled,
					readyVisible: buttons.some((button) => button.textContent?.trim() === 'Ready'),
					deckSaved: text.includes('Deck saved'),
					alerts: document.querySelectorAll('[role=alert]').length
				};
			})
			.catch(() => ({ pageUnavailable: true }));
		console.info('Lobby failure flags', { ...state, pageErrors, consoleErrors });
		throw error;
	} finally {
		try {
			// Close the disposable room even when an assertion fails, avoiding the host's room quota.
			if (/\/room\//.test(a.url())) {
				await activate(a.getByText('Close room', { exact: true }));
				await choose(a.getByLabel('I understand'));
				await activate(a.getByRole('button', { name: 'Confirm close', exact: true }));
				await expect(a).toHaveURL(/\/play$/, { timeout: 20000 });
			}
		} finally {
			mark('disposing contexts');
			await Promise.all([host.close(), guest.close()]);
			mark('contexts disposed');
		}
	}
});

// This smaller real-service journey can run before problem calibration is complete.
test('a real development account verifies email, persists its nickname, and recovers a private room', async ({
	page
}) => {
	const tokenFile = required
		? join(process.env.MATCH_E2E_PRIVATE_DIR!, 'testing-token.json')
		: process.env.MATCH_E2E_TESTING_TOKEN_FILE;
	const passFile = required
		? join(process.env.MATCH_E2E_PRIVATE_DIR!, test.info().project.name, 'new-pass')
		: process.env.MATCH_E2E_HOST_PASS_FILE;
	test.skip(
		!required && (!target || !tokenFile || !passFile),
		'Requires a real dev frontend, official Clerk testing token, and unused backend host pass.'
	);
	test.setTimeout(120000);
	if (required) {
		const email = await readFile(
			join(process.env.MATCH_E2E_PRIVATE_DIR!, test.info().project.name, 'new-email'),
			'utf8'
		);
		await hostedSignIn(page, page.context(), email, target! + '/sign-in#next=%2Fplay');
	} else {
		const { token } = JSON.parse(await readFile(tokenFile!, 'utf8')) as { token: string };
		await page.context().route(/https:\/\/[^/]+\.clerk\.accounts\.dev\/v1\//, async (route) => {
			const url = new URL(route.request().url());
			url.searchParams.set('__clerk_testing_token', token);
			await route.continue({ url: url.href });
		});
		await page.goto(target! + '/sign-in#next=%2Fplay');
		await activate(page.getByRole('button', { name: 'Continue with Clerk', exact: true }));
		await page
			.getByLabel('Email address', { exact: true })
			.fill(`beatcode-e2e-${Date.now()}+clerk_test@example.com`);
		await activate(page.getByRole('button', { name: 'Continue', exact: true }));
		await page
			.getByRole('textbox', { name: /verification code/i })
			.first()
			.fill('424242');
	}
	await page.getByLabel('Nickname', { exact: true }).fill('UI host');
	await activate(page.getByRole('button', { name: 'Save nickname', exact: true }));
	await page
		.locator('summary')
		.filter({ hasText: /^Redeem host pass$/ })
		.press('Enter');
	await page.getByLabel('Host pass').fill((await readFile(passFile!, 'utf8')).trim());
	await activate(page.getByRole('button', { name: 'Redeem host pass', exact: true }));
	await expect(page.getByRole('button', { name: 'Create room', exact: true })).toBeEnabled();
	await page.reload();
	await expect(page.getByText('UI host', { exact: true })).toBeVisible();
	await activate(page.getByText('Edit nickname', { exact: true }));
	await expect(page.getByLabel('Nickname', { exact: true })).toHaveValue('UI host');
	await activate(page.getByRole('button', { name: 'Create room', exact: true }));
	const firstInvite = await page.getByLabel('Invitation link').inputValue();
	await page.reload();
	await expect(page.getByLabel('Invitation link')).toHaveValue(firstInvite);
	await activate(page.getByRole('button', { name: 'Generate new invitation', exact: true }));
	await expect(page.getByLabel('Invitation link')).not.toHaveValue(firstInvite);
	expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
	await activate(page.getByText('Close room', { exact: true }));
	await choose(page.getByLabel('I understand'));
	await activate(page.getByRole('button', { name: 'Confirm close', exact: true }));
	await expect(page).toHaveURL(/\/play$/);
	if (process.env.MATCH_E2E_SAVE_STATE) {
		await page.context().storageState({ path: process.env.MATCH_E2E_SAVE_STATE });
		await chmod(process.env.MATCH_E2E_SAVE_STATE, 0o600);
	}
});

test('strict compile reaches a scored verdict and round result through the authenticated UI', async ({
	browser
}, testInfo) => {
	test.skip(
		!required && (!target || !hostState || !guestState),
		'Requires two real Clerk sessions'
	);
	test.setTimeout(120000);
	const host = await browser.newContext({
		storageState: hostState!,
		viewport: testInfo.project.use.viewport
	});
	const guest = await browser.newContext({
		storageState: guestState!,
		viewport: testInfo.project.use.viewport
	});
	try {
		const a = await host.newPage(),
			b = await guest.newPage();
		const presence = observePresence(a);
		const strictAC = observeScoredResult(a);
		await a.goto(target! + '/play');
		await activate(a.getByRole('button', { name: 'Create room', exact: true }));
		await b.goto(await a.getByLabel('Invitation link').inputValue());
		await activate(b.getByRole('button', { name: 'Join room', exact: true }));
		for (const page of [a, b]) {
			for (const name of ['Light mode', 'No paste', 'No hints', 'Strict compile'])
				await choose(page.getByRole('checkbox', { name: new RegExp(name) }));
			await activate(page.getByRole('button', { name: 'Save deck', exact: true }));
			await activate(page.getByRole('button', { name: 'Ready', exact: true }));
			await expect(page.getByRole('button', { name: 'Cancel ready', exact: true })).toBeVisible();
		}
		await expect(a).toHaveURL(/\/match\//);
		await expect(b).toHaveURL(/\/match\//);
		for (const [source, receiver] of [
			[a, b],
			[b, a]
		]) {
			await panel(source, 'Cards');
			const card = source.getByRole('button', { name: /^Strict compile ·/ });
			await expect(card).toBeEnabled({ timeout: 25000 });
			await activate(card);
			await expect(
				receiver.getByRole('listitem').filter({ hasText: /^Strict compile on you ·/ })
			).toBeVisible();
			await panel(receiver, 'Code');
			await expect(
				receiver.getByText(
					'Next scored submission: ISO C++20 + -pedantic-errors. Samples do not consume this effect.'
				)
			).toBeVisible();
		}
		await panel(a, 'Code');
		await a.getByRole('textbox', { name: 'C++ solution', exact: true }).fill(sumSource);
		await activate(a.getByRole('button', { name: 'Submit solution', exact: true }));
		await panel(a, 'Results');
		await expect
			.poll(strictAC, { message: 'Real member history must acknowledge an AC with strict profile' })
			.toBe(true);
		await expect(a.getByRole('table', { name: 'Server round results' })).toContainText(
			'CI host wins'
		);
		await activate(a.getByRole('button', { name: 'Concede match', exact: true }));
		await activate(a.getByRole('button', { name: 'Confirm concede', exact: true }));
		for (const page of [a, b]) {
			await expect(page.getByRole('heading', { name: 'Match result', exact: true })).toBeVisible();
			expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
		}
		const account = await host.newPage();
		await account.goto(target! + '/sign-in');
		await activate(account.getByRole('button', { name: 'Sign out', exact: true }));
		await expect(a.getByRole('heading', { name: 'Sign in to play', exact: true })).toBeVisible();
		await expectPresenceStopped(a, presence);
	} finally {
		await host.close();
		await guest.close();
	}
});
