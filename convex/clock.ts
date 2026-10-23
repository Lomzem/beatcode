import { Effect } from 'effect';
import { runBackend } from './game/effect';
import { mutation } from './_generated/server';
import { requirePlayer } from './game/access';
export const ping = mutation({
	args: {},
	handler: (ctx) =>
		runBackend(
			Effect.gen(function* () {
				yield* requirePlayer(ctx);
				return { serverNow: Date.now() };
			})
		)
});
