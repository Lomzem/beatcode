import type { Doc } from '../_generated/dataModel';
import type { BackendFailure } from './effect';
import { Effect } from 'effect';
import { step } from './effect';
import type { MutationCtx } from '../_generated/server';
export function settings(ctx: MutationCtx): Effect.Effect<Doc<'ops'>, BackendFailure> {
	return Effect.gen(function* () {
		const existing = yield* step(
			ctx.db
				.query('ops')
				.withIndex('by_key', (q) => q.eq('key', 'global'))
				.unique()
		);
		if (existing) return existing;
		const id = yield* step(
			ctx.db.insert('ops', {
				key: 'global',
				judgingEnabled: false,
				maxInFlight: 10,
				inFlight: 0,
				dailySecondsCap: 12000,
				monthlySecondsCap: 250000,
				monthlyActionSecondsCap: 115200,
				updatedAt: Date.now()
			})
		);
		return (yield* step(ctx.db.get(id)))!;
	});
}
export function daily(
	ctx: MutationCtx,
	day = new Date(Date.now()).toISOString().slice(0, 10)
): Effect.Effect<Doc<'usageDaily'>, BackendFailure> {
	return Effect.gen(function* () {
		const existing = yield* step(
			ctx.db
				.query('usageDaily')
				.withIndex('by_day', (q) => q.eq('day', day))
				.unique()
		);
		if (existing) return existing;
		const id = yield* step(
			ctx.db.insert('usageDaily', {
				day,
				playersCreated: 0,
				scored: 0,
				samples: 0,
				reservedSeconds: 0,
				actualSeconds: 0,
				actionSeconds: 0
			})
		);
		return (yield* step(ctx.db.get(id)))!;
	});
}
export function monthly(
	ctx: MutationCtx,
	month = new Date(Date.now()).toISOString().slice(0, 7)
): Effect.Effect<Doc<'usageMonthly'>, BackendFailure> {
	return Effect.gen(function* () {
		const existing = yield* step(
			ctx.db
				.query('usageMonthly')
				.withIndex('by_month', (q) => q.eq('month', month))
				.unique()
		);
		if (existing) return existing;
		const id = yield* step(
			ctx.db.insert('usageMonthly', {
				month,
				actualSeconds: 0,
				actionSeconds: 0,
				reservedSeconds: 0
			})
		);
		return (yield* step(ctx.db.get(id)))!;
	});
}
