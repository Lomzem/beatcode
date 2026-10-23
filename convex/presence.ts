import { Effect } from 'effect';
import { runBackend, step, reject } from './game/effect';
import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { member } from './game/access';
export const heartbeat = mutation({
	args: { roomId: v.id('rooms') },
	handler: (ctx, { roomId }) =>
		runBackend(
			Effect.gen(function* () {
				const { room, seat } = yield* member(ctx, roomId);
				if (room.status === 'closed') return yield* reject('BAD_STATE');
				yield* step(ctx.db.patch(roomId, { lastSeen: { ...room.lastSeen, [seat]: Date.now() } }));
			})
		)
});
