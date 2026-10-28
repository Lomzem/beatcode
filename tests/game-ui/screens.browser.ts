import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FIXTURE_NOW, fixtureNames, type FixtureName } from './fixtures';
import { isolate } from './isolation';

type Primary = {
	role: 'button' | 'link';
	name: string;
	/** Narrow layouts show one Match panel at a time; the walk opens this tab first. */
	tab?: string;
};
type Screen = {
	/** The action a keyboard user must reach; null when the state offers none. */
	primary: Primary | null;
	perceive: (page: Page, theme: Theme) => Promise<void>;
};
const themes = ['dark', 'light', 'contrast'] as const;
type Theme = (typeof themes)[number];

async function openPanel(page: Page, name: string) {
	const tab = page.getByRole('tab', { name, exact: true });
	if (await tab.isVisible()) await tab.click();
}
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const status = (page: Page, text: string | RegExp) =>
	page.getByRole('status').filter({ hasText: text });

const screens: Record<FixtureName, Screen> = {
	rooms: {
		primary: { role: 'button', name: 'Create room' },
		async perceive(page) {
			await expect(page.getByRole('heading', { name: 'Rooms' })).toBeVisible();
			await expect(button(page, 'Create room')).toBeEnabled();
			await expect(page.getByText('Playing as Ada')).toBeVisible();
		}
	},
	'room-open': {
		primary: { role: 'button', name: 'Generate new invitation' },
		async perceive(page) {
			await expect(page.getByRole('heading', { name: 'Players' })).toBeVisible();
			await expect(page.getByRole('listitem')).toHaveText([
				'Ada (you) — Connected recently',
				'Waiting for opponent — Seat open'
			]);
			await expect(page.getByRole('heading', { name: 'Invite your opponent' })).toBeVisible();
			await expect(page.getByText('It expires after 24 hours.', { exact: false })).toBeVisible();
			await expect(button(page, 'Generate new invitation')).toBeEnabled();
		}
	},
	'room-lobby': {
		primary: { role: 'button', name: 'Ready' },
		async perceive(page) {
			await expect(page.getByRole('listitem')).toHaveText([
				'Ada (you) — Connected recently · Not ready',
				'Grace — Connected recently · Ready'
			]);
			await expect(page.getByRole('heading', { name: 'Choose your deck' })).toBeVisible();
			await expect(status(page, 'Deck saved')).toBeVisible();
			const deck = page.getByRole('group', { name: 'Choose exactly four cards' });
			await expect(deck.getByRole('checkbox')).toHaveCount(5);
			await expect(deck.getByRole('checkbox', { checked: true })).toHaveCount(4);
			await expect(deck.getByRole('checkbox', { name: /No hints · 2 power/ })).not.toBeChecked();
			await expect(button(page, 'Save deck')).toBeDisabled();
			await expect(button(page, 'Ready')).toBeEnabled();
			await expect(page.getByText('Your saved deck is ready.', { exact: false })).toBeVisible();
		}
	},
	'room-results': {
		primary: { role: 'button', name: 'Request rematch' },
		async perceive(page) {
			await expect(page.getByRole('heading', { name: 'Match finished' })).toBeVisible();
			await expect(page.getByRole('link', { name: 'View match result' })).toBeVisible();
			await expect(button(page, 'Request rematch')).toBeEnabled();
		}
	},
	'room-closed': {
		primary: { role: 'link', name: 'Return to play' },
		async perceive(page) {
			await expect(status(page, 'This room is closed.')).toBeVisible();
			await expect(page.getByText('Close room')).toHaveCount(0);
		}
	},
	'match-active': {
		primary: { role: 'button', name: 'Submit solution', tab: 'Code' },
		async perceive(page) {
			await expectScoreboard(page, 'Round 1 · active', 'Ada 0 — 0 Grace');
			await expect(page.getByText('Power 2 of 10')).toBeVisible();
			await expect(page.getByText('Next power in 5 seconds')).toBeVisible();
			await expect(page.getByText('No hints on opponent · 0:12')).toBeVisible();
			await expect(page.getByRole('heading', { name: 'Pair sums' })).toBeVisible();
			await openPanel(page, 'Cards');
			await expect(button(page, 'Light mode · 1 power · Used this round')).toBeDisabled();
			await expect(button(page, 'No paste · 2 power · Ready')).toBeEnabled();
			await expect(button(page, 'Brain teaser · 3 power · More power needed')).toBeDisabled();
			await expect(button(page, 'Strict compile · 4 power · More power needed')).toBeDisabled();
			await openPanel(page, 'Code');
			// The editor starts from a C++ template, so both requests are available.
			await expect(button(page, 'Submit solution')).toBeEnabled();
			await expect(button(page, 'Run samples')).toBeEnabled();
			await openPanel(page, 'Problem');
		}
	},
	'match-brain-teaser': {
		primary: { role: 'button', name: 'Check answer', tab: 'Code' },
		async perceive(page) {
			await expect(page.getByText('Brain teaser on you · 0:13')).toBeVisible();
			await expect(page.getByText('Solve the brain teaser to submit.')).toBeVisible();
			await openPanel(page, 'Code');
			await expect(page.getByRole('heading', { name: 'Brain teaser' })).toBeVisible();
			await expect(page.getByRole('spinbutton', { name: 'What is 17 + 25?' })).toBeVisible();
			await expect(button(page, 'Submit solution')).toBeDisabled();
			await expect(button(page, 'Go to brain teaser')).toBeEnabled();
			await openPanel(page, 'Problem');
		}
	},
	'match-light-mode': {
		primary: { role: 'button', name: 'Submit solution', tab: 'Code' },
		async perceive(page, theme) {
			await expect(page.getByText('Light mode on you · 0:18')).toBeVisible();
			// The Card forces the light palette; a Player who chose high contrast keeps it.
			await expect
				.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
				.toBe(theme === 'contrast' ? 'dark' : 'light');
		}
	},
	'match-settling': {
		// No primary action while the server settles the Round; only Concede match remains.
		primary: null,
		async perceive(page) {
			await expectScoreboard(page, 'Round 1 · settling', 'Ada 0 — 0 Grace');
			await expect(page.getByRole('heading', { name: 'Settling round' })).toBeVisible();
			await expect(page.getByText('Submissions wait for an active round.')).toBeVisible();
			await expect(page.getByText('No active effects.')).toBeVisible();
			await openPanel(page, 'Code');
			await expect(button(page, 'Submit solution')).toBeDisabled();
			await openPanel(page, 'Problem');
		}
	},
	'match-intermission': {
		primary: { role: 'button', name: 'Ready for next round' },
		async perceive(page) {
			await expectScoreboard(page, 'Round 2 · intermission', 'Ada 1 — 0 Grace');
			await expect(page.getByText('0:20 until start')).toBeVisible();
			await expect(page.getByRole('heading', { name: 'Intermission' })).toBeVisible();
			await expect(page.getByText('Next round starts in 0:20.', { exact: false })).toBeVisible();
			await expect(button(page, 'Ready for next round')).toBeEnabled();
			await expect(page.getByText('Submissions wait for an active round.')).toBeVisible();
		}
	},
	'match-finished': {
		primary: { role: 'link', name: 'Return to room' },
		async perceive(page) {
			await expectScoreboard(page, 'Round 2 · finished', 'Ada 2 — 0 Grace');
			await expect(page.getByRole('heading', { name: 'Match result' })).toBeVisible();
			await expect(page.getByText('Ada wins. Reason: rounds.')).toBeVisible();
			await expect(page.getByRole('link', { name: 'Return to room' })).toBeVisible();
			await expect(button(page, 'Request rematch')).toBeEnabled();
			await expect(button(page, 'Share my source')).toBeEnabled();
			await expect(button(page, 'Concede match')).toHaveCount(0);
			await openPanel(page, 'Results');
			const rounds = page.getByRole('table', { name: 'Server round results' });
			await expect(rounds.getByRole('rowheader')).toHaveText(['1', '2']);
			await expect(rounds.getByRole('cell')).toHaveText([
				/^Ada wins\s*Opponent verdicts: WA$/,
				/^Ada wins\s*Opponent verdicts: TLE$/
			]);
			await openPanel(page, 'Problem');
		}
	}
};
async function expectScoreboard(page: Page, round: string, score: string) {
	await expect(page.getByText(round, { exact: true })).toBeVisible();
	await expect(page.getByText(score, { exact: true })).toBeVisible();
}

test('the network guard blocks and reports requests outside the fixture server', async ({
	context,
	page
}) => {
	const outbound = await isolate(context);
	await page.goto('/?state=rooms');
	const fetched = await page.evaluate(() =>
		fetch('https://example.com/probe').then(
			() => 'loaded',
			() => 'blocked'
		)
	);
	await page.evaluate(() => void new WebSocket('wss://example.com/socket'));
	expect(fetched).toBe('blocked');
	await expect
		.poll(() => outbound)
		.toEqual(['https://example.com/probe', 'wss://example.com/socket']);
});

for (const name of fixtureNames)
	for (const theme of themes)
		test(`${name} in the ${theme} theme`, async ({ context, page }, testInfo) => {
			const outbound = await isolate(context);
			await page.clock.setFixedTime(FIXTURE_NOW);
			await page.emulateMedia({ reducedMotion: 'reduce' });
			const errors: string[] = [];
			page.on('pageerror', (error) => errors.push(error.message));
			await page.goto(`/?state=${name}&theme=${theme}`);
			const screen = screens[name];

			await screen.perceive(page, theme);

			// Narrow Match layouts expose one panel at a time; scan each of them.
			const tabs = await page.getByRole('tab').allTextContents();
			for (const panel of tabs.length ? tabs : ['page']) {
				if (tabs.length) await openPanel(page, panel);
				const axe = await new AxeBuilder({ page })
					.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
					.analyze();
				await testInfo.attach(`axe-results-${panel}`, {
					body: JSON.stringify(axe, null, 2),
					contentType: 'application/json'
				});
				expect(axe.violations, `axe violations: ${panel}`).toEqual([]);
				expect(
					await page.evaluate(
						() => document.documentElement.scrollWidth - document.documentElement.clientWidth
					),
					`page-level horizontal overflow: ${panel}`
				).toBeLessThanOrEqual(0);
				await expectNoRunningAnimations(page);
			}

			if (screen.primary) await reachByKeyboard(page, screen.primary);
			await expectNoRunningAnimations(page);
			expect(errors).toEqual([]);
			expect(outbound).toEqual([]);
		});

/** Tabs from the top of the page like a keyboard-only Player until the primary action has focus. */
async function reachByKeyboard(page: Page, primary: Primary) {
	// Start from the top of a fresh page; Firefox does not wrap Tab back to the start.
	await page.reload();
	// The target may start inside a hidden Match panel.
	const target = page.getByRole(primary.role, {
		name: primary.name,
		exact: true,
		includeHidden: true
	});
	await expect(target).toHaveCount(1);
	const focus = () =>
		page.evaluate(() => {
			const element = document.activeElement;
			return {
				role: element?.getAttribute('role'),
				label: element?.getAttribute('aria-label'),
				text: element?.textContent
			};
		});
	for (let presses = 0; presses < 80; presses++) {
		await page.keyboard.press('Tab');
		if (await target.evaluate((element) => element === document.activeElement))
			return expectVisibleFocus(target);
		const focused = await focus();
		if (primary.tab && focused.role === 'tab' && focused.text !== primary.tab) {
			for (let step = 0; step < 4 && (await focus()).text !== primary.tab; step++)
				await page.keyboard.press('ArrowRight');
		} else if (focused.role === 'textbox' && focused.label === 'C++ solution') {
			// The editor keeps Tab for indentation; Escape then Tab leaves it.
			await page.keyboard.press('Escape');
		}
	}
	throw new Error(`${primary.name} was not reached by keyboard`);
}
/** Requires an opaque outline of at least 2px, or a box shadow, that appears only while focused. */
async function expectVisibleFocus(target: Locator) {
	const ring = await target.evaluate((element) => {
		const indicator = () => {
			const style = getComputedStyle(element);
			const outline =
				style.outlineStyle !== 'none' &&
				parseFloat(style.outlineWidth) >= 2 &&
				!/^transparent$|^rgba\(.*,\s*0\)$/.test(style.outlineColor);
			return { outline, shadow: style.boxShadow };
		};
		const focusVisible = element.matches(':focus-visible');
		const focused = indicator();
		(element as HTMLElement).blur();
		const resting = indicator();
		return {
			focusVisible,
			drawn: (focused.outline && !resting.outline) || focused.shadow !== resting.shadow
		};
	});
	expect(ring.focusVisible, 'focus is keyboard-visible').toBe(true);
	expect(ring.drawn, 'focus indicator appears on focus').toBe(true);
}
/** Samples once the state has rendered and again after keyboard interaction. */
async function expectNoRunningAnimations(page: Page) {
	expect(
		await page.evaluate(
			() => document.getAnimations().filter((a) => a.playState === 'running').length
		),
		'running animations under reduced motion'
	).toBe(0);
}
