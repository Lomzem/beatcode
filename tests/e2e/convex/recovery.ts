import { internalMutationGeneric, internalQueryGeneric } from 'convex/server';
import { v } from 'convex/values';
import { assertCiDeployment, CI_BACKEND_URL } from '../deployment';
import { recoveryIntent } from './schema';
import { Effect } from 'effect';
import { runBackend, step, syncStep } from '../../../convex/game/effect';

export const put = internalMutationGeneric({
	args: { intent: recoveryIntent },
	handler: (ctx, { intent }) =>
		runBackend(
			Effect.gen(function* () {
				yield* syncStep(assertCiDeployment);
				yield* syncStep(() => {
					const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
					if (
						intent.backend !== CI_BACKEND_URL ||
						!uuid.test(intent.runId) ||
						!uuid.test(intent.accountId) ||
						intent.requestedAt < intent.startedAt
					)
						throw new Error('Invalid CI recovery identity');
				});
				const previous = yield* step(
					ctx.db
						.query('ciAccountRecovery')
						.withIndex('by_account', (q) => q.eq('accountId', intent.accountId))
						.unique()
				);
				if (previous) {
					yield* syncStep(() => {
						if (previous.runId !== intent.runId || previous.requestedAt !== intent.requestedAt)
							throw new Error('CI recovery ownership mismatch');
					});
					yield* step(ctx.db.replace(previous._id, intent));
				} else yield* step(ctx.db.insert('ciAccountRecovery', intent));
			})
		)
});
export const list = internalQueryGeneric({
	args: {},
	handler: (ctx) =>
		runBackend(
			Effect.gen(function* () {
				yield* syncStep(assertCiDeployment);
				const rows = yield* step(ctx.db.query('ciAccountRecovery').take(1001));
				yield* syncStep(() => {
					if (rows.length > 1000) throw new Error('CI recovery capacity exceeded');
				});
				return rows.map((row) => ({
					runId: row.runId,
					startedAt: row.startedAt,
					backend: row.backend,
					accountId: row.accountId,
					requestedAt: row.requestedAt,
					state: row.state,
					...(row.clerkId ? { clerkId: row.clerkId } : {})
				}));
			})
		)
});
export const remove = internalMutationGeneric({
	args: { accountId: v.string(), runId: v.string() },
	handler: (ctx, args) =>
		runBackend(
			Effect.gen(function* () {
				yield* syncStep(assertCiDeployment);
				const row = yield* step(
					ctx.db
						.query('ciAccountRecovery')
						.withIndex('by_account', (q) => q.eq('accountId', args.accountId))
						.unique()
				);
				if (!row) return;
				yield* syncStep(() => {
					if (row.runId !== args.runId || !['deleted', 'rejected'].includes(row.state))
						throw new Error('CI recovery unresolved');
				});
				yield* step(ctx.db.delete(row._id));
			})
		)
});
