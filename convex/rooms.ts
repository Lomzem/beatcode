import { Effect } from 'effect';
import { runBackend, step, reject } from './game/effect';
import { activeCatalog } from './game/catalog';
import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { member, requirePlayer } from './game/access';
import { hashToken, secretToken } from './game/tokens';
export const create = mutation({
	args: {},
	handler: (ctx) =>
		runBackend(
			Effect.gen(function* () {
				const p = yield* requirePlayer(ctx);
				const rooms = yield* step(
					ctx.db
						.query('rooms')
						.withIndex('by_host', (q) => q.eq('hostId', p._id))
						.collect()
				);
				if (rooms.filter((r) => r.status !== 'closed').length >= 2) return yield* reject('QUOTA');
				const inviteToken = secretToken();
				const roomId = yield* step(
					ctx.db.insert('rooms', {
						hostId: p._id,
						inviteHash: yield* hashToken(inviteToken),
						inviteExpiresAt: Date.now() + 86400_000,
						inviteFailures: 0,
						status: 'open',
						ready: { host: false, guest: false },
						rematch: { host: false, guest: false },
						lastSeen: { host: Date.now() }
					})
				);
				return { roomId, inviteToken };
			})
		)
});
export const join = mutation({
	args: { roomId: v.id('rooms'), inviteToken: v.string() },
	handler: (ctx, { roomId, inviteToken }) =>
		runBackend(
			Effect.gen(function* () {
				const p = yield* requirePlayer(ctx);
				const r = yield* step(ctx.db.get(roomId));
				// A committed rejection is necessary: throwing would roll back abuse counters.
				const rejected = (code: string) => ({ ok: false as const, error: { code, message: code } });
				if (r?.guestId === p._id && r.status !== 'closed') return { ok: true as const, roomId };
				const prior = p.failedJoins;
				const count = prior && Date.now() - prior.windowStart < 3600_000 ? prior.count : 0;
				if (count >= 10) return rejected('QUOTA');
				const hash = inviteToken.length <= 128 ? yield* hashToken(inviteToken) : '';
				if (
					!r ||
					r.hostId === p._id ||
					r.status !== 'open' ||
					r.guestId ||
					!r.inviteHash ||
					hash !== r.inviteHash ||
					(r.inviteExpiresAt ?? 0) <= Date.now()
				) {
					yield* step(
						ctx.db.patch(p._id, {
							failedJoins: {
								windowStart: count ? prior!.windowStart : Date.now(),
								count: count + 1
							}
						})
					);
					if (r && r.status === 'open')
						yield* step(
							ctx.db.patch(r._id, {
								inviteFailures: r.inviteFailures + 1,
								...(r.inviteFailures >= 19 ? { inviteHash: undefined } : {})
							})
						);
					return rejected('NOT_FOUND');
				}
				yield* step(
					ctx.db.patch(roomId, {
						guestId: p._id,
						status: 'lobby',
						inviteHash: undefined,
						lastSeen: { ...r.lastSeen, guest: Date.now() }
					})
				);
				return { ok: true as const, roomId };
			})
		)
});
export const view = query({
	args: { roomId: v.id('rooms') },
	handler: (ctx, { roomId }) =>
		runBackend(
			Effect.gen(function* () {
				const { player, room: r, seat } = yield* member(ctx, roomId);
				const h = yield* step(ctx.db.get(r.hostId)),
					g = r.guestId ? yield* step(ctx.db.get(r.guestId)) : null;
				const decks = yield* step(
					ctx.db
						.query('decks')
						.withIndex('by_room_player', (q) => q.eq('roomId', roomId))
						.collect()
				);
				return {
					roomId,
					status: r.status,
					ownDeck: decks.find((d) => d.playerId === player._id)?.cardIds ?? [],
					opponentDeck:
						r.status === 'in_match' || r.status === 'results'
							? (decks.find(
									(d) => d.playerId !== player._id && d.lockedForMatchId === r.currentMatchId
								)?.cardIds ?? null)
							: null,
					host: { playerId: r.hostId, displayName: h!.displayName },
					guest: g ? { playerId: g._id, displayName: g.displayName } : null,
					seat,
					ready: r.ready,
					lastSeen: r.lastSeen,
					currentMatchId: r.currentMatchId ?? null,
					playerId: player._id
				};
			})
		)
});
import { internal } from './_generated/api';
export const setReady = mutation({
	args: { roomId: v.id('rooms'), ready: v.boolean() },
	handler: (ctx, args): Promise<void> =>
		runBackend(
			Effect.gen(function* () {
				const { player, room, seat } = yield* member(ctx, args.roomId);
				if (room.status !== 'lobby') return yield* reject('BAD_STATE');
				const deck = yield* step(
					ctx.db
						.query('decks')
						.withIndex('by_room_player', (q) => q.eq('roomId', room._id).eq('playerId', player._id))
						.unique()
				);
				if (args.ready && (!deck || deck.cardIds.length !== 4)) return yield* reject('BAD_INPUT');
				const ready = { ...room.ready, [seat]: args.ready };
				if (ready.host && ready.guest) yield* activeCatalog(ctx);
				if (room.startScheduledId) yield* step(ctx.scheduler.cancel(room.startScheduledId));
				const startScheduledId =
					ready.host && ready.guest
						? yield* step(
								ctx.scheduler.runAfter(3000, internal.matches._start, { roomId: room._id })
							)
						: undefined;
				yield* step(ctx.db.patch(room._id, { ready, startScheduledId }));
			})
		)
});
export const requestRematch = mutation({
	args: { roomId: v.id('rooms') },
	handler: (ctx, { roomId }) =>
		runBackend(
			Effect.gen(function* () {
				const { room, seat } = yield* member(ctx, roomId);
				if (room.status !== 'results' || !room.guestId) return yield* reject('BAD_STATE');
				const rematch = { ...room.rematch, [seat]: true };
				if (rematch.host && rematch.guest) {
					const decks = yield* step(
						ctx.db
							.query('decks')
							.withIndex('by_room_player', (q) => q.eq('roomId', roomId))
							.collect()
					);
					for (const d of decks) yield* step(ctx.db.patch(d._id, { lockedForMatchId: undefined }));
					yield* step(
						ctx.db.patch(roomId, {
							status: 'lobby',
							ready: { host: false, guest: false },
							rematch: { host: false, guest: false }
						})
					);
				} else yield* step(ctx.db.patch(roomId, { rematch }));
			})
		)
});
import { internalMutation } from './_generated/server';
import { finishMatch } from './game/rounds';
export const _reap = internalMutation({
	args: {},
	handler: (ctx) =>
		runBackend(
			Effect.gen(function* () {
				const rooms = (yield* Effect.forEach(
					['open', 'lobby', 'in_match', 'results'] as const,
					(status) =>
						step(
							ctx.db
								.query('rooms')
								.withIndex('by_status', (q) => q.eq('status', status))
								.collect()
						)
				)).flat();
				for (const room of rooms)
					if (Date.now() - Math.max(room.lastSeen.host, room.lastSeen.guest ?? 0) > 1800000) {
						if (room.currentMatchId) {
							const match = yield* step(ctx.db.get(room.currentMatchId));
							if (match?.status === 'active') yield* finishMatch(ctx, match, 'aborted', 'expired');
						}
						if (room.startScheduledId) yield* step(ctx.scheduler.cancel(room.startScheduledId));
						yield* step(
							ctx.db.patch(room._id, {
								status: 'closed',
								inviteHash: undefined,
								startScheduledId: undefined
							})
						);
					}
			})
		)
});
export const regenerateInvite = mutation({
	args: { roomId: v.id('rooms') },
	handler: (ctx, { roomId }) =>
		runBackend(
			Effect.gen(function* () {
				const { room, seat } = yield* member(ctx, roomId);
				if (seat !== 'host') return yield* reject('NOT_FOUND');
				if (room.status !== 'open' || room.guestId) return yield* reject('BAD_STATE');
				const inviteToken = secretToken();
				yield* step(
					ctx.db.patch(roomId, {
						inviteHash: yield* hashToken(inviteToken),
						inviteExpiresAt: Date.now() + 86400000,
						inviteFailures: 0
					})
				);
				return { inviteToken };
			})
		)
});
export const close = mutation({
	args: { roomId: v.id('rooms') },
	handler: (ctx, { roomId }) =>
		runBackend(
			Effect.gen(function* () {
				const { room, seat } = yield* member(ctx, roomId);
				if (seat !== 'host') return yield* reject('NOT_FOUND');
				if (room.status === 'in_match') return yield* reject('BAD_STATE');
				if (room.startScheduledId) yield* step(ctx.scheduler.cancel(room.startScheduledId));
				yield* step(
					ctx.db.patch(roomId, {
						status: 'closed',
						inviteHash: undefined,
						startScheduledId: undefined,
						ready: { host: false, guest: false }
					})
				);
			})
		)
});
export const leave = mutation({
	args: { roomId: v.id('rooms') },
	handler: (ctx, { roomId }) =>
		runBackend(
			Effect.gen(function* () {
				const { room, seat } = yield* member(ctx, roomId);
				if (seat !== 'guest') return yield* reject('NOT_FOUND');
				if (room.status !== 'lobby' && room.status !== 'results') return yield* reject('BAD_STATE');
				if (room.startScheduledId) yield* step(ctx.scheduler.cancel(room.startScheduledId));
				yield* step(
					ctx.db.patch(roomId, {
						guestId: undefined,
						status: 'open',
						inviteHash: undefined,
						inviteFailures: 0,
						startScheduledId: undefined,
						ready: { host: false, guest: false },
						rematch: { host: false, guest: false },
						lastSeen: { host: room.lastSeen.host }
					})
				);
			})
		)
});
