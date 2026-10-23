import { test, expect } from '@playwright/test';
import { activate } from './e2e/accounts';
import { observeActivation } from './e2e/activation-diagnostics';

test('native activation samples the retained button after it removes itself', async ({ page }) => {
	await page.setContent('<button onclick="this.remove()"><strong>Play card</strong></button>');
	const control = page.getByRole('button', { name: 'Play card' });
	const probe = await observeActivation(control);
	try {
		expect(probe).toBeDefined();
		await activate(control);
		await probe!.after();
		expect(await page.getByRole('button').count()).toBe(0);
		expect(probe!.read()).toEqual({
			beforeVisible: true,
			beforeEnabled: true,
			beforeFocused: false,
			afterVisible: false,
			afterEnabled: true,
			afterFocused: false,
			enterCount: 1,
			enterOnControl: true,
			enterPrevented: false,
			clickCount: 1,
			clickOnControl: true
		});
	} finally {
		await probe?.close();
	}
});

test('native prevention is observed after a later listener finishes dispatch', async ({ page }) => {
	await page.setContent('<button onclick="this.textContent=\'Activated\'">Play card</button>');
	const control = page.getByRole('button');
	const probe = await observeActivation(control);
	try {
		expect(probe).toBeDefined();
		await page.evaluate(() =>
			document.addEventListener(
				'keydown',
				(event) => {
					if (event.key === 'Enter') event.preventDefault();
				},
				{ once: true }
			)
		);
		await activate(control);
		await probe!.after();
		await expect(control).toHaveText('Play card');
		expect(probe!.read()).toMatchObject({
			enterCount: 1,
			enterOnControl: true,
			enterPrevented: true,
			clickCount: 0,
			clickOnControl: false
		});
	} finally {
		await probe?.close();
	}
});

test('native input on another control is distinguished from selected card activation', async ({
	page
}) => {
	await page.setContent(
		'<button style="display:none">Play card</button><button onclick="this.textContent=\'Other activated\'">Other</button>'
	);
	const control = page.locator('button').first();
	await page.getByRole('button', { name: 'Other', exact: true }).focus();
	const probe = await observeActivation(control);
	try {
		expect(probe).toBeDefined();
		await activate(control);
		await probe!.after();
		await expect(page.getByRole('button')).toHaveText('Other activated');
		expect(probe!.read()).toEqual({
			beforeVisible: false,
			beforeEnabled: true,
			beforeFocused: false,
			afterVisible: false,
			afterEnabled: true,
			afterFocused: false,
			enterCount: 1,
			enterOnControl: false,
			enterPrevented: false,
			clickCount: 1,
			clickOnControl: false
		});
	} finally {
		await probe?.close();
	}
});

test('closing the native observation releases listeners while preserving the caller error', async ({
	page
}) => {
	await page.setContent('<button>Play card</button>');
	await page.evaluate(() => {
		const live = new Set<EventListenerOrEventListenerObject>();
		const add = document.addEventListener.bind(document),
			remove = document.removeEventListener.bind(document);
		document.addEventListener = ((
			type: string,
			listener: EventListenerOrEventListenerObject,
			options?: boolean | AddEventListenerOptions
		) => {
			if ((type === 'keydown' || type === 'click') && options === true) live.add(listener);
			add(type, listener, options);
		}) as typeof document.addEventListener;
		document.removeEventListener = ((
			type: string,
			listener: EventListenerOrEventListenerObject,
			options?: boolean | EventListenerOptions
		) => {
			live.delete(listener);
			remove(type, listener, options);
		}) as typeof document.removeEventListener;
		Object.assign(window, { nativeSubscriptionCount: () => live.size });
	});
	const original = new Error('Synthetic caller assertion');
	const control = page.getByRole('button');
	const operation = async () => {
		const probe = await observeActivation(control);
		try {
			expect(probe).toBeDefined();
			expect(
				await page.evaluate(() =>
					(window as unknown as { nativeSubscriptionCount(): number }).nativeSubscriptionCount()
				)
			).toBe(2);
			await activate(control);
			throw original;
		} finally {
			await probe?.close();
		}
	};
	await expect(operation()).rejects.toBe(original);
	expect(
		await page.evaluate(() =>
			(window as unknown as { nativeSubscriptionCount(): number }).nativeSubscriptionCount()
		)
	).toBe(0);
});
