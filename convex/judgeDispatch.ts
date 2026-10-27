import { Effect } from 'effect';
import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { runBackend, step } from './game/effect';
// The separately implemented trusted Node controller owns sandbox execution.
// Failure callbacks are classified transactionally from the authenticated attempt
// stage by _fail; transport callers cannot manufacture an infrastructure void.
export const _run = internalAction({
	args: { attemptId: v.id('judgeAttempts'), leaseVersion: v.number() },
	handler: (ctx, args): Promise<void> =>
		runBackend(
			Effect.gen(function* () {
				yield* step(ctx.runAction(internal.judgeController._run, args)).pipe(
					Effect.catch(() =>
						step(
							ctx.runMutation(internal.judge._fail, {
								...args,
								code: 'CONTROLLER_UNAVAILABLE'
							})
						)
					)
				);
			})
		)
});
export const _terminate = internalAction({
	args: { sandboxId: v.string() },
	handler: (ctx, args): Promise<void> =>
		runBackend(
			Effect.gen(function* () {
				yield* step(ctx.runAction(internal.judgeController._terminate, args));
			})
		)
});
