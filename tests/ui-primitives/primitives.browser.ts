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

test('long select exposes pointer scroll controls and keeps end options reachable by keyboard', async ({
	page
}, testInfo) => {
	await page.goto('/?select');
	const trigger = page.getByRole('combobox', { name: 'Problem', exact: true });
	await trigger.click();
	const down = page.locator('[data-slot="select-scroll-down-button"]');
	await expect(down).toBeVisible();
	// Preserve baseline diagnostics for the unchanged portaled listbox; keyboard access is exercised below.
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
