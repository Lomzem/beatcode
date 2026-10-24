import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ context, page }) => {
	await context.route('**/*', (route) => {
		const url = new URL(route.request().url());
		return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
	});
	await page.goto('/');
});

test('disabled link blocks actions and bubbling; enabled link keeps pointer and keyboard behavior', async ({
	page
}) => {
	const link = page.getByRole('link', { name: 'Run action' });
	await expect(link).toHaveAttribute('aria-disabled', 'true');
	await link.click({ force: true });
	await expect(page.getByLabel('Actions', { exact: true })).toHaveText('0');
	await expect(page.getByLabel('Parent actions')).toHaveText('0');
	const nativeButton = page.getByRole('button', { name: 'Native action' });
	await nativeButton.click();
	await expect(page.getByLabel('Handler receiver')).toHaveText('BUTTON');
	await expect(nativeButton).toBeFocused();
	await page.getByRole('button', { name: 'Toggle disabled' }).click();
	await link.click();
	await expect(page.getByLabel('Actions', { exact: true })).toHaveText('1');
	await expect(page.getByLabel('Handler receiver')).toHaveText('A');
	await expect(page).toHaveURL(/#destination$/);
	await link.focus();
	await page.keyboard.press('Enter');
	await expect(page.getByLabel('Actions', { exact: true })).toHaveText('2');
	await expect(page.getByLabel('Handler receiver')).toHaveText('A');
	await expect(page.getByLabel('Parent actions')).toHaveText('2');
	expect(
		(
			await new AxeBuilder({ page })
				.withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
				.analyze()
		).violations
	).toEqual([]);
});

test('file input ignores invalid defaults, binds files and clears without breaking text inputs', async ({
	page
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto('/?file');
	const upload = page.getByLabel('Upload solution');
	await expect(upload).toBeVisible();
	expect(errors).toEqual([]);
	await upload.setInputFiles({
		name: 'solution.cpp',
		mimeType: 'text/plain',
		buffer: Buffer.from('int main() {}')
	});
	await expect(page.getByLabel('Selected file')).toHaveText('solution.cpp');
	await page.getByRole('button', { name: 'Clear upload' }).click();
	await expect(page.getByLabel('Selected file')).toHaveText('None');
	await expect(upload).toHaveValue('');
	await page.getByLabel('Description', { exact: true }).fill('Updated');
	await expect(page.getByLabel('Description value')).toHaveText('Updated');
	expect(errors).toEqual([]);
	expect(
		(
			await new AxeBuilder({ page })
				.withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
				.analyze()
		).violations
	).toEqual([]);
});

test('checkbox input binds checked state both ways by pointer, keyboard and program', async ({
	page
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto('/?checkbox');
	const checkbox = page.getByRole('checkbox', { name: 'Share solution' });
	await expect(checkbox).not.toBeChecked();
	await expect(checkbox).toHaveAttribute('value', 'yes');
	await checkbox.click();
	await expect(checkbox).toBeChecked();
	await expect(page.getByLabel('Share state')).toHaveText('Shared');
	await checkbox.press('Space');
	await expect(checkbox).not.toBeChecked();
	await expect(page.getByLabel('Share state')).toHaveText('Private');
	await page.getByRole('button', { name: 'Toggle share' }).click();
	await expect(checkbox).toBeChecked();
	expect(errors).toEqual([]);
	expect(
		(
			await new AxeBuilder({ page })
				.withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
				.analyze()
		).violations
	).toEqual([]);
});

test('long select exposes pointer scroll controls and keeps end options reachable by keyboard', async ({
	page
}, testInfo) => {
	await page.goto('/?select');
	const trigger = page.getByRole('combobox', { name: 'Problem', exact: true });
	await trigger.click();
	const down = page.locator('[data-slot="select-scroll-down-button"]');
	await expect(down).toBeVisible();
	// The default portal places the listbox outside main, so axe reports `region`; the portal-disabled
	// select test covers the inline listbox. Keyboard access is exercised below.
	await testInfo.attach('open-select-accessibility.json', {
		body: JSON.stringify((await new AxeBuilder({ page }).analyze()).violations, null, 2),
		contentType: 'application/json'
	});
	await page.screenshot({ path: testInfo.outputPath('select-open.png') });
	await down.hover();
	const last = page.getByRole('option', { name: 'Problem 30', exact: true });
	await expect(last).toBeInViewport({ ratio: 0.9, timeout: 15000 });
	await last.click();
	await expect(page.getByLabel('Selected problem')).toHaveText('30');
	await expect(trigger).toBeFocused();
	await trigger.press('ArrowDown');
	await page.keyboard.press('Home');
	await page.keyboard.press('Enter');
	await expect(page.getByLabel('Selected problem')).toHaveText('1');
	await trigger.press('ArrowDown');
	await page.keyboard.press('End');
	await page.keyboard.press('Enter');
	await expect(page.getByLabel('Selected problem')).toHaveText('30');
	await expect(trigger).toBeFocused();
});

test('portal-disabled select passes axe at default height; End brings the last option fully into view in a short viewport', async ({
	page
}, testInfo) => {
	await page.goto('/?portal-disabled-select');
	const trigger = page.getByRole('combobox', { name: 'Short select', exact: true });
	await trigger.press('Enter');
	const last = page.getByRole('option', { name: 'Fourth', exact: true });
	await expect(last).toBeVisible();
	expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
	await page.keyboard.press('Escape');
	await expect(trigger).toBeFocused();

	// CSS viewport height equivalent to a 1024px-tall window at 400% zoom (not real browser zoom);
	// the options must overflow the listbox.
	await page.setViewportSize({ width: page.viewportSize()!.width, height: 256 });
	await trigger.press('Enter');
	await expect(last).not.toBeInViewport({ ratio: 1 });
	await page.keyboard.press('End');
	await expect(last).toBeInViewport({ ratio: 1 });
	// Evidence only: axe may flag the overflowing listbox scroll container here; keyboard reach is
	// asserted above instead of a diagnostic shape.
	await testInfo.attach('short-viewport-select-accessibility.json', {
		body: JSON.stringify((await new AxeBuilder({ page }).analyze()).violations, null, 2),
		contentType: 'application/json'
	});
	await page.keyboard.press('Enter');
	await expect(page.getByLabel('Selected short option')).toHaveText('fourth');
	await expect(trigger).toBeFocused();
});
