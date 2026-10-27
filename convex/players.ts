import { Effect } from 'effect';
import { runBackend, step, syncStep, reject } from './game/effect';
import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { displayName, identity, requirePlayer } from './game/access';
export const ensure = mutation({
	args: { displayName: v.string() },
	handler: (ctx, args) =>
		runBackend(
			Effect.gen(function* () {
				const user = yield* identity(ctx);
				const existing = yield* step(
					ctx.db
						.query('players')
						.withIndex('by_token', (q) => q.eq('tokenIdentifier', user.tokenIdentifier))
						.unique()
				);
				if (existing) {
					if (existing.disabled) return yield* reject('DISABLED');
					return { playerId: existing._id };
				}
				const name = yield* syncStep(() => displayName(args.displayName));
				const today = new Date(Date.now()).toISOString().slice(0, 10);
				const usage = yield* step(
					ctx.db
						.query('usageDaily')
						.withIndex('by_day', (q) => q.eq('day', today))
						.unique()
				);
				if ((usage?.playersCreated ?? 0) >= 50) return yield* reject('QUOTA');
				if (usage)
					yield* step(ctx.db.patch(usage._id, { playersCreated: usage.playersCreated + 1 }));
				else
					yield* step(
						ctx.db.insert('usageDaily', {
							day: today,
							playersCreated: 1,
							scored: 0,
							samples: 0,
							reservedSeconds: 0,
							actualSeconds: 0,
							actionSeconds: 0
						})
					);
				const playerId = yield* step(
					ctx.db.insert('players', {
						tokenIdentifier: user.tokenIdentifier,
						displayName: name,
						canHost: false,
						disabled: false,
						createdAt: Date.now()
					})
				);
				return { playerId };
			})
		)
});
export const me = query({
	args: {},
	handler: (ctx) =>
		runBackend(
			Effect.gen(function* () {
				const user = yield* identity(ctx);
				const p = yield* step(
					ctx.db
						.query('players')
						.withIndex('by_token', (q) => q.eq('tokenIdentifier', user.tokenIdentifier))
						.unique()
				);
				if (!p) return null;
				if (p.disabled) return yield* reject('DISABLED');
				return { playerId: p._id, displayName: p.displayName, canHost: p.canHost };
			})
		)
});
import { hashToken } from './game/tokens';
export const redeemHostPass = mutation({
	args: { code: v.string() },
	handler: (ctx, { code }) =>
		runBackend(
			Effect.gen(function* () {
				const player = yield* requirePlayer(ctx);
				if (code.length > 128) return yield* reject('BAD_INPUT');
				const hash = yield* hashToken(code);
				const found = yield* step(
					ctx.db
						.query('hostPasses')
						.withIndex('by_hash', (q) => q.eq('codeHash', hash))
						.unique()
				);
				if (
					!found ||
					found.expiresAt <= Date.now() ||
					(found.redeemedBy && found.redeemedBy !== player._id)
				)
					return yield* reject('BAD_INPUT');
				if (!found.redeemedBy)
					yield* step(ctx.db.patch(found._id, { redeemedBy: player._id, redeemedAt: Date.now() }));
				yield* step(ctx.db.patch(player._id, { canHost: true }));
			})
		)
});
export const rename = mutation({
	args: { displayName: v.string() },
	handler: (ctx, args) =>
		runBackend(
			Effect.gen(function* () {
				const p = yield* requirePlayer(ctx);
				const name = yield* syncStep(() => displayName(args.displayName));
				yield* step(ctx.db.patch(p._id, { displayName: name }));
				const rooms = [
					...(yield* step(
						ctx.db
							.query('rooms')
							.withIndex('by_host', (q) => q.eq('hostId', p._id))
							.collect()
					)),
					...(yield* step(
						ctx.db
							.query('rooms')
							.withIndex('by_guest', (q) => q.eq('guestId', p._id))
							.collect()
					))
				];
				for (const r of rooms)
					if (r.status === 'lobby') {
						if (r.startScheduledId) yield* step(ctx.scheduler.cancel(r.startScheduledId));
						yield* step(
							ctx.db.patch(r._id, {
								ready: { ...r.ready, [r.hostId === p._id ? 'host' : 'guest']: false },
								startScheduledId: undefined
							})
						);
					}
			})
		)
});
