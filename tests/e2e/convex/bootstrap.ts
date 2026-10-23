import { assertCiDeployment } from '../deployment';
import { Effect } from 'effect';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, internalAction } from '../../../convex/_generated/server';
import { runBackend, step, syncStep } from '../../../convex/game/effect';
import schema from '../../../convex/schema';
import type { DataModel } from '../../../convex/_generated/dataModel';

// Internal admin-only fixture interface, compiled solely into the CI artifact.
export const clearPage = internalMutation({
	args: { table: v.string() },
	handler: (ctx, { table }) =>
		runBackend(
			Effect.gen(function* () {
				yield* syncStep(assertCiDeployment);
				if (!Object.hasOwn(schema.tables, table)) throw new Error('Unknown CI fixture table');
				const rows = yield* step(ctx.db.query(table as keyof DataModel).take(100));
				if (table === 'problemVersions') {
					for (const row of yield* step(ctx.db.query('problemVersions').take(100)))
						if (yield* step(ctx.db.system.get(row.testsStorageId)))
							yield* step(ctx.storage.delete(row.testsStorageId));
				}
				for (const row of rows) yield* step(ctx.db.delete(row._id));
				return rows.length;
			})
		)
});
export const cancelPage = internalMutation({
	args: {},
	handler: (ctx) =>
		runBackend(
			Effect.gen(function* () {
				yield* syncStep(assertCiDeployment);
				const jobs = yield* step(
					ctx.db.system
						.query('_scheduled_functions')
						.filter((q) => q.eq(q.field('state.kind'), 'pending'))
						.take(100)
				);
				for (const job of jobs) yield* step(ctx.scheduler.cancel(job._id));
				return jobs.length;
			})
		)
});
export const reset = internalAction({
	args: {},
	handler: (ctx): Promise<void> =>
		runBackend(
			Effect.gen(function* () {
				yield* syncStep(assertCiDeployment);
				const cancel = makeFunctionReference<'mutation', Record<string, never>, number>(
					'bootstrap:cancelPage'
				);
				while (yield* step(ctx.runMutation(cancel, {}))) {
					/* Drain scheduled fixture work. */
				}
				const clear = makeFunctionReference<'mutation', { table: string }, number>(
					'bootstrap:clearPage'
				);
				for (const table of Object.keys(schema.tables))
					while (yield* step(ctx.runMutation(clear, { table }))) {
						/* Bounded DB transactions. */
					}
			})
		)
});
export const insertFixtures = internalMutation({
	args: { testsStorageId: v.id('_storage') },
	handler: (ctx, { testsStorageId }) =>
		runBackend(
			Effect.gen(function* () {
				yield* syncStep(assertCiDeployment);
				const judgeEnvId = yield* step(
					ctx.db.insert('judgeEnvironments', {
						envId: 'ci-fake-not-calibrated',
						modalImageId: 'CI-NO-SANDBOX',
						baseDigest: 'CI-FIXTURE',
						gccVersion: 'CI-NO-COMPILER',
						runtime: 'gvisor',
						cpu: 1,
						runnerSha256: 'CI-FIXTURE',
						status: 'active'
					})
				);
				for (const difficulty of [1, 2, 3] as const)
					for (const variant of [1, 2]) {
						const problemId = yield* step(
							ctx.db.insert('problems', {
								slug: `ci-${difficulty}-${variant}`,
								title: 'CI sum fixture',
								difficulty,
								retired: false
							})
						);
						const versionId = yield* step(
							ctx.db.insert('problemVersions', {
								problemId,
								version: 1,
								statementMd: 'Read two integers and print their sum. CI fixture: no C++ execution.',
								samples: [{ input: '2 3', output: '5' }],
								limits: { timeMs: 1000, memoryMiB: 256, outputKiB: 64, aggregateMs: 15000 },
								testsStorageId,
								testsSha256: 'CI-FIXTURE',
								packageSha256: 'CI-FIXTURE',
								judgeEnvId,
								status: 'active'
							})
						);
						yield* step(ctx.db.patch(problemId, { activeVersionId: versionId }));
					}
			})
		)
});
export const seed = internalAction({
	args: {},
	handler: (ctx): Promise<void> =>
		runBackend(
			Effect.gen(function* () {
				yield* syncStep(assertCiDeployment);
				const testsStorageId = yield* step(
					ctx.storage.store(new Blob(['CI fixture; never real judge input']))
				);
				yield* step(
					ctx.runMutation(makeFunctionReference<'mutation'>('bootstrap:insertFixtures'), {
						testsStorageId
					})
				);
				// Production admission defaults to paused. Enable only this guarded fake-judge app
				// through the existing trusted operator, never by changing production defaults.
				yield* step(
					ctx.runMutation(makeFunctionReference<'mutation'>('ops:setJudging'), { enabled: true })
				);
			})
		)
});
