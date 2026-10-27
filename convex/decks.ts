import { Effect } from 'effect';
import { runBackend, step, reject } from './game/effect';
import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { member } from './game/access';
import { cardId } from './game/validators';
export const set = mutation({
	args: { roomId: v.id('rooms'), cardIds: v.array(cardId) },
	handler: (ctx, args) =>
		runBackend(
			Effect.gen(function* () {
				const { player, room, seat } = yield* member(ctx, args.roomId);
				if (room.status !== 'lobby') return yield* reject('BAD_STATE');
				if (args.cardIds.length !== 4 || new Set(args.cardIds).size !== 4)
					return yield* reject('BAD_INPUT');
				const deck = yield* step(
					ctx.db
						.query('decks')
						.withIndex('by_room_player', (q) => q.eq('roomId', room._id).eq('playerId', player._id))
						.unique()
				);
				if (deck)
					yield* step(
						ctx.db.patch(deck._id, { cardIds: args.cardIds, lockedForMatchId: undefined })
					);
				else
					yield* step(
						ctx.db.insert('decks', {
							roomId: room._id,
							playerId: player._id,
							cardIds: args.cardIds
						})
					);
				if (room.startScheduledId) yield* step(ctx.scheduler.cancel(room.startScheduledId));
				yield* step(
					ctx.db.patch(room._id, {
						ready: { ...room.ready, [seat]: false },
						startScheduledId: undefined
					})
				);
			})
		)
});
