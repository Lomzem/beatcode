import { Effect, Data } from 'effect';
import { readFile } from 'node:fs/promises';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, type BrowserContext, type Locator } from '@playwright/test';
import { observeAuthBoundary } from './auth-diagnostics';

export class AccountFailure extends Data.TaggedError('AccountFailure')<{ message: string }> {}
export const accountStep = <A>(tryPromise: () => Promise<A>) =>
	Effect.tryPromise({
		try: tryPromise,
		catch: (error) => {
			privateDiagnostic(
				error instanceof Error ? { message: error.message, stack: error.stack } : { failure: true }
			);
			return new AccountFailure({ message: 'Hosted development account operation failed' });
		}
	});
export function hostedSignIn(
	page: Page,
	context: BrowserContext,
	email: string,
	destination: string
) {
	const boundary = observeAuthBoundary(page, new URL(destination).origin);
	return Effect.runPromise(
		Effect.gen(function* () {
			const { token } = yield* accountStep(
				async () =>
					JSON.parse(
						await readFile(join(process.env.MATCH_E2E_PRIVATE_DIR!, 'testing-token.json'), 'utf8')
					) as { token: string }
			);
			yield* accountStep(() =>
				context.route(/https:\/\/[^/]+\.clerk\.accounts\.dev\/v1\//, async (route) => {
					const url = new URL(route.request().url());
					url.searchParams.set('__clerk_testing_token', token);
					await route.continue({ url: url.href });
				})
			);
			yield* accountStep(async () => {
				console.info('CI auth: entry');
				await page.goto(destination);
				console.info('CI auth: portal');
				await activate(page.getByRole('button', { name: 'Continue with Clerk', exact: true }));
				await expect(page).toHaveURL(/\.accounts\.dev\/sign-in/, { timeout: 30000 });
				console.info('CI auth: email');
				await page.getByLabel('Email address', { exact: true }).fill(email);
				// Hosted UI renders the OTP field before its asynchronous prepare request
				// finishes. Verify only after Clerk has acknowledged sending this factor.
				const prepared = page.waitForResponse(
					(response) =>
						new URL(response.url()).pathname.endsWith('/prepare_first_factor') &&
						response.request().method() === 'POST',
					{ timeout: 30000 }
				);
				await activate(page.getByRole('button', { name: 'Continue', exact: true }));
				const preparation = await prepared;
				await preparation.finished();
				expect(preparation.ok(), 'Clerk must prepare email verification before code entry').toBe(
					true
				);
				console.info('CI auth: code');
				await page
					.getByRole('textbox', { name: /verification code/i })
					.first()
					.fill('424242');
				console.info('CI auth: return');
				await expect(page).toHaveURL(
					new RegExp(
						'^' + process.env.MATCH_E2E_URL!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/play'
					),
					{ timeout: 30000 }
				);
			});
		}).pipe(
			Effect.tapError(() =>
				Effect.promise(async () => {
					const flags = await page
						.evaluate(() => ({
							app: location.origin === 'http://localhost:4173',
							portal: location.hostname.endsWith('.accounts.dev'),
							play: location.pathname === '/play',
							signin: location.pathname === '/sign-in',
							account: [...document.querySelectorAll('a')].some((a) => a.textContent === 'Account'),
							connection: document.body.textContent?.includes('Sign-in could not connect') ?? false,
							code: !!document.querySelector('input[autocomplete="one-time-code"]')
						}))
						.catch(() => null);
					if (flags) console.info('CI auth flags: ' + Object.values(flags).map(Number).join(''));
					const line = await boundary.line();
					if (line) console.info(line);
					privateDiagnostic({
						portalText: await page
							.locator('body')
							.innerText()
							.catch(() => 'unavailable')
					});
				})
			),
			Effect.ensuring(Effect.sync(() => boundary.close()))
		)
	);
}

export async function activate(control: Locator) {
	await expect(control).toBeEnabled({ timeout: 30000 });
	await control.press('Enter');
}

export async function choose(control: Locator, checked = true) {
	await expect(control).toBeEnabled({ timeout: 30000 });
	await control.focus();
	if ((await control.isChecked()) !== checked) await control.press('Space');
	if (checked) await expect(control).toBeChecked();
	else await expect(control).not.toBeChecked();
}

function privateDiagnostic(value: unknown) {
	const directory = process.env.MATCH_E2E_DIAGNOSTICS_DIR;
	if (!directory) return;
	try {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		appendFileSync(join(directory, 'hosted-errors.private.jsonl'), JSON.stringify(value) + '\n', {
			mode: 0o600
		});
	} catch {
		/* Diagnostics cannot replace the sanitized failure. */
	}
}
