import { Effect } from 'effect';
import { chromium, firefox, webkit, type FullConfig } from '@playwright/test';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { mkdir, chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDevAccount } from './clerk-resources';
import { hostedSignIn, accountStep, activate } from './accounts';

export default function setup(config: Pick<FullConfig, 'projects'>) {
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const directory = process.env.MATCH_E2E_PRIVATE_DIR!;
				const target = process.env.MATCH_E2E_URL!;
				const client = new ConvexHttpClient(process.env.PUBLIC_CONVEX_URL!, {
					logger: false,
					fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) })
				});
				(client as ConvexHttpClient & { setAdminAuth(key: string): void }).setAdminAuth(
					process.env.CONVEX_CI_DEPLOY_KEY!
				);
				for (const project of config.projects) {
					const folder = join(directory, project.name);
					yield* accountStep(() => mkdir(folder, { mode: 0o700 }));
					const browser = yield* Effect.acquireRelease(
						accountStep(() =>
							({ chromium, firefox, webkit })[
								project.name.split('-')[0] as 'chromium' | 'firefox' | 'webkit'
							].launch()
						),
						(browser) => accountStep(() => browser.close()).pipe(Effect.orDie)
					);
					for (const role of ['host', 'guest', 'new']) {
						console.info(`CI progress: ${project.name} ${role} create`);
						const email = yield* createDevAccount(process.env.MATCH_E2E_RECOVERY_DIR!);
						yield* accountStep(() =>
							writeFile(join(folder, `${role}-email`), email, { mode: 0o600 })
						);
						if (role !== 'guest') {
							const { code } = yield* accountStep(() =>
								client.mutation(
									makeFunctionReference<'mutation', { note: string }, { code: string }>(
										'ops:mintHostPass'
									),
									{ note: 'Ephemeral authenticated CI' }
								)
							);
							yield* accountStep(() =>
								writeFile(join(folder, `${role}-pass`), code, { mode: 0o600 })
							);
						}
						if (role === 'new') continue;
						const context = yield* accountStep(() =>
							browser.newContext({ viewport: project.use.viewport ?? undefined })
						);
						const page = yield* accountStep(() => context.newPage());
						console.info(`CI progress: ${project.name} ${role} signin`);
						yield* accountStep(() =>
							hostedSignIn(page, context, email, `${target}/sign-in#next=%2Fplay`)
						);
						yield* accountStep(async () => {
							await page
								.getByLabel('Nickname', { exact: true })
								.fill(role === 'host' ? 'CI host' : 'CI guest');
							await activate(page.getByRole('button', { name: 'Save nickname', exact: true }));
							if (role === 'host') {
								console.info(`CI progress: ${project.name} ${role} pass`);
								await page
									.locator('summary')
									.filter({ hasText: /^Redeem host pass$/ })
									.press('Enter');
								const { readFile } = await import('node:fs/promises');
								await page
									.getByLabel('Host pass', { exact: true })
									.fill(await readFile(join(folder, 'host-pass'), 'utf8'));
								await page
									.getByRole('button', { name: 'Redeem host pass', exact: true })
									.press('Enter');
								await page.getByRole('button', { name: 'Create room', exact: true }).waitFor();
							} else await page.getByText('CI guest', { exact: true }).waitFor();
							const state = join(folder, `${role}.json`);
							await writeFile(state, '', { mode: 0o600 });
							await context.storageState({ path: state });
							await chmod(state, 0o600);
							await context.close();
							console.info(`CI progress: ${project.name} ${role} saved`);
						});
					}
				}
			})
		)
	);
}
