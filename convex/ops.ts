import { Effect } from 'effect';
import { runBackend, step, reject } from './game/effect';
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { settings } from './game/usage';
import { internal } from './_generated/api';
export const setJudging = internalMutation({
	args: { enabled: v.boolean() },
	handler: (ctx, { enabled }): Promise<void> =>
		runBackend(
			Effect.gen(function* () {
				const ops = yield* settings(ctx);
				yield* step(ctx.db.patch(ops._id, { judgingEnabled: enabled, updatedAt: Date.now() }));
				if (enabled) yield* step(ctx.scheduler.runAfter(0, internal.judge._pump, {}));
			})
		)
});
export const revokePlayer = internalMutation({
	args: { playerId: v.id('players') },
	handler: (ctx, { playerId }) =>
		runBackend(
			Effect.gen(function* () {
				const player = yield* step(ctx.db.get(playerId));
				if (!player) return yield* reject('NOT_FOUND');
				yield* step(ctx.db.patch(playerId, { disabled: true }));
			})
		)
});
export const declareIncident = internalMutation({
	args: { code: v.string(), note: v.optional(v.string()) },
	handler: (ctx, args) =>
		runBackend(
			Effect.gen(function* () {
				if (!/^[A-Z0-9_]{1,80}$/.test(args.code) || (args.note?.length ?? 0) > 200)
					return yield* reject('BAD_INPUT');
				return yield* step(
					ctx.db.insert('infraIncidents', {
						at: Date.now(),
						source: 'operator',
						code: args.code,
						...(args.note ? { note: args.note } : {})
					})
				);
			})
		)
});
import { purgePage } from './game/retention';
export const _purge = internalMutation({
	args: {
		phase: v.optional(v.number()),
		cursor: v.optional(v.string()),
		at: v.optional(v.number())
	},
	handler: (ctx, args): Promise<void> =>
		runBackend(
			Effect.gen(function* () {
				const phase = args.phase ?? 0,
					at = args.at ?? Date.now();
				if (
					!Number.isInteger(phase) ||
					phase < 0 ||
					phase > 12 ||
					!Number.isFinite(at) ||
					at > Date.now()
				)
					return yield* reject('BAD_INPUT');
				const page = yield* purgePage(ctx, phase, args.cursor ?? null, at);
				if (!page.isDone)
					yield* step(
						ctx.scheduler.runAfter(0, internal.ops._purge, {
							phase,
							cursor: page.continueCursor,
							at
						})
					);
				else if (phase < 12)
					yield* step(ctx.scheduler.runAfter(0, internal.ops._purge, { phase: phase + 1, at }));
			})
		)
});
export const annulMatch = internalMutation({
	args: { matchId: v.id('matches'), note: v.optional(v.string()) },
	handler: (ctx, { matchId, note }) =>
		runBackend(
			Effect.gen(function* () {
				if ((note?.length ?? 0) > 200) return yield* reject('BAD_INPUT');
				const match = yield* step(ctx.db.get(matchId));
				if (!match) return yield* reject('NOT_FOUND');
				if (match.status !== 'finished') return yield* reject('BAD_STATE');
				if (match.reason === 'annulled_by_operator') return;
				yield* step(
					ctx.db.patch(matchId, {
						result: 'aborted',
						winnerId: undefined,
						reason: 'annulled_by_operator'
					})
				);
				yield* step(
					ctx.db.insert('auditLog', {
						at: Date.now(),
						kind: 'annul_match',
						refId: matchId,
						detail: note ?? 'Annulled by operator'
					})
				);
			})
		)
});
export const setCaps = internalMutation({
	args: {
		maxInFlight: v.number(),
		dailySecondsCap: v.number(),
		monthlySecondsCap: v.number(),
		monthlyActionSecondsCap: v.number()
	},
	handler: (ctx, caps): Promise<void> =>
		runBackend(
			Effect.gen(function* () {
				const bounds = {
					maxInFlight: 10,
					dailySecondsCap: 12000,
					monthlySecondsCap: 250000,
					monthlyActionSecondsCap: 115200
				};
				for (const key of Object.keys(bounds) as (keyof typeof bounds)[]) {
					if (!Number.isSafeInteger(caps[key]) || caps[key] < 1 || caps[key] > bounds[key])
						return yield* reject('BAD_INPUT');
				}
				const ops = yield* settings(ctx);
				yield* step(ctx.db.patch(ops._id, { ...caps, updatedAt: Date.now() }));
				yield* step(
					ctx.db.insert('auditLog', {
						at: Date.now(),
						kind: 'set_caps',
						detail: JSON.stringify(caps)
					})
				);
				yield* step(ctx.scheduler.runAfter(0, internal.judge._pump, {}));
			})
		)
});
import { internalQuery } from './_generated/server';
import { timingReport as reportTiming } from './game/timing';
export const timingReport = internalQuery({
	args: { problemVersionId: v.id('problemVersions') },
	handler: (ctx, { problemVersionId }) =>
		runBackend(
			Effect.gen(function* () {
				return yield* reportTiming(ctx, problemVersionId);
			})
		)
});

// Transitional deployment only: see docs/migrations/retire-host-passes.md.
// The final schema deliberately has no types for the retired table or field.
import type { GenericDatabaseWriter, GenericDataModel } from 'convex/server';
import type { GenericId } from 'convex/values';
export const retireHostPasses = internalMutation({
	args: {
		phase: v.union(v.literal('players'), v.literal('passes')),
		cursor: v.union(v.string(), v.null())
	},
	handler: (ctx, { phase, cursor }) =>
		runBackend(
			Effect.gen(function* () {
				const db: GenericDatabaseWriter<GenericDataModel> = ctx.db;
				const page = yield* step(
					db
						.query(phase === 'players' ? 'players' : 'hostPasses')
						.paginate({ cursor, numItems: 100 })
				);
				for (const row of page.page) {
					if (phase === 'players') {
						if ('canHost' in row)
							yield* step(db.patch(row._id as GenericId<'players'>, { canHost: undefined }));
					} else yield* step(db.delete(row._id as GenericId<'hostPasses'>));
				}
				return { done: page.isDone, cursor: page.continueCursor };
			})
		)
});
