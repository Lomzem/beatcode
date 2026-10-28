import { Effect } from 'effect';
import { chromium, firefox, webkit, type FullConfig } from '@playwright/test';
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
							await page
								.getByText(role === 'host' ? 'CI host' : 'CI guest', { exact: true })
								.waitFor();
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
