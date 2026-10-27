import { afterEach, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from './convex/schema';
import { CI_BACKEND_URL } from './deployment';
import { randomUUID } from 'node:crypto';

const modules = {
	...import.meta.glob('../../convex/**/*.ts'),
	'../../convex/recovery.ts': () => import('./convex/recovery'),
	'../../convex/bootstrap.ts': () => import('./convex/bootstrap'),
	'../../convex/judgeController.ts': () => import('./convex/judgeController')
};
afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});
it.each([
	undefined,
	'https://descriptive-scorpion-877.convex.cloud',
	'https://careful-greyhound-596.convex.cloud'
])('the CI artifact refuses destructive operations on deployment %s', async (deployment) => {
	vi.stubEnv('CONVEX_CLOUD_URL', deployment);
	const t = convexTest(schema, modules);
	await expect(t.query(makeFunctionReference<'query'>('recovery:list'), {})).rejects.toThrow(
		'CI_ARTIFACT_WRONG_DEPLOYMENT'
	);
	await expect(
		t.mutation(makeFunctionReference<'mutation'>('recovery:remove'), {
			runId: randomUUID(),
			accountId: randomUUID()
		})
	).rejects.toThrow('CI_ARTIFACT_WRONG_DEPLOYMENT');
	for (const name of ['bootstrap:reset', 'bootstrap:seed', 'judgeController:_reap'])
		await expect(t.action(makeFunctionReference<'action'>(name), {})).rejects.toThrow(
			'CI_ARTIFACT_WRONG_DEPLOYMENT'
		);
	await expect(
		t.action(makeFunctionReference<'action'>('judgeController:_terminate'), {
			sandboxId: 'CI-not-a-real-sandbox'
		})
	).rejects.toThrow('CI_ARTIFACT_WRONG_DEPLOYMENT');
	await expect(
		t.mutation(makeFunctionReference<'mutation'>('bootstrap:clearPage'), { table: 'players' })
	).rejects.toThrow('CI_ARTIFACT_WRONG_DEPLOYMENT');
	await expect(
		t.mutation(makeFunctionReference<'mutation'>('bootstrap:cancelPage'), {})
	).rejects.toThrow('CI_ARTIFACT_WRONG_DEPLOYMENT');
});

it('fixture reset preserves private recovery and refuses removing unresolved intent', async () => {
	vi.stubEnv('CONVEX_CLOUD_URL', CI_BACKEND_URL);
	const t = convexTest(schema, modules);
	const intent = {
		runId: randomUUID(),
		accountId: randomUUID(),
		startedAt: Date.now(),
		requestedAt: Date.now(),
		backend: CI_BACKEND_URL,
		state: 'planned'
	};
	await t.mutation(makeFunctionReference<'mutation'>('recovery:put'), { intent });
	await t.action(makeFunctionReference<'action'>('bootstrap:reset'), {});
	expect(await t.query(makeFunctionReference<'query'>('recovery:list'), {})).toEqual([intent]);
	await expect(
		t.mutation(makeFunctionReference<'mutation'>('recovery:remove'), {
			runId: intent.runId,
			accountId: intent.accountId
		})
	).rejects.toThrow('CI recovery unresolved');
	await t.mutation(makeFunctionReference<'mutation'>('recovery:put'), {
		intent: { ...intent, state: 'deleted' }
	});
	await t.mutation(makeFunctionReference<'mutation'>('recovery:remove'), {
		runId: intent.runId,
		accountId: intent.accountId
	});
	expect(await t.query(makeFunctionReference<'query'>('recovery:list'), {})).toEqual([]);
});

it('advances cleanup in bounded pages through historical scheduler receipts', async () => {
	vi.useFakeTimers();
	vi.stubEnv('CONVEX_CLOUD_URL', CI_BACKEND_URL);
	const t = convexTest({ schema, modules, transactionLimits: { documentsRead: 4096 } });
	const task = makeFunctionReference<'mutation'>('rooms:_reap');
	// Genuine cancelled scheduler receipts, created in bounded fixture transactions.
	for (let batch = 0; batch < 42; batch++) {
		await t.run(async (ctx) => {
			for (let i = 0; i < 100; i++) {
				const id = await ctx.scheduler.runAfter(60000, task, {});
				await ctx.scheduler.cancel(id);
			}
		});
	}
	const pending = await t.run((ctx) => ctx.scheduler.runAfter(60000, task, {}));
	const firstPage = await t.mutation(makeFunctionReference<'mutation'>('bootstrap:cancelPage'), {});
	// One bounded page must not scan thousands of old receipts to reach later work.
	expect(await t.run((ctx) => ctx.db.system.get(pending))).toMatchObject({
		state: { kind: 'pending' }
	});
	expect(firstPage).toMatchObject({ isDone: false });
	await t.action(makeFunctionReference<'action'>('bootstrap:reset'), {});
	// The platform receipt confirms cleanup, even when pending work follows old history.
	expect(await t.run((ctx) => ctx.db.system.get(pending))).toMatchObject({
		state: { kind: 'canceled' }
	});
});
