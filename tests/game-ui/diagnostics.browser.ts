import { expect, test } from '@playwright/test';

test('the newest scored or sample attempt replaces or clears compiler diagnostics', async ({
	context,
	page
}) => {
	await context.route('**/*', (route) =>
		new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()
	);
	await context.routeWebSocket(/.*/, (socket) => socket.close());
	await page.goto('/');
	const code = page.getByRole('tab', { name: 'Code', exact: true });
	if (await code.isVisible()) await code.click();
	await expect(page.getByRole('textbox', { name: 'C++ solution' })).toBeVisible();
	const diagnostics = page.locator('details').filter({ hasText: 'Compiler diagnostics' });
	for (const [newest, withError] of [
		['sample', true],
		['sample', false],
		['scored', true],
		['scored', false]
	] as const) {
		await page.evaluate(
			({ newest, withError }) => {
				const error = 'main.cpp:1:1: error: newest compiler message';
				const old = 'main.cpp:1:1: error: obsolete compiler message';
				window.dispatchEvent(
					new CustomEvent('public-attempts', {
						detail: {
							ownSubmissions: [
								{
									receivedAt: newest === 'scored' ? 200 : 100,
									seq: 1,
									status: 'done',
									...(newest !== 'scored' || withError
										? { diagnostics: newest === 'scored' ? error : old }
										: {})
								}
							],
							ownSampleRuns: [
								{
									createdAt: newest === 'sample' ? 200 : 100,
									status: 'done',
									diagnostics: newest === 'sample' ? (withError ? error : null) : old
								}
							]
						}
					})
				);
			},
			{ newest, withError }
		);
		if (withError) await expect(diagnostics).toContainText('newest compiler message');
		else await expect(diagnostics).toHaveCount(0);
		await expect(page.getByText('obsolete compiler message', { exact: false })).toHaveCount(0);
	}
});
