// This artifact is deployed only by tests/e2e/run.ts to the dedicated CI project.
// It never executes contestant source or imports the Modal controller.
import { assertCiDeployment } from '../deployment';
import { Effect } from 'effect';
import { v } from 'convex/values';
import { internalAction } from '../../../convex/_generated/server';
import { internal } from '../../../convex/_generated/api';
import { runBackend, step, syncStep } from '../../../convex/game/effect';

export const _run = internalAction({
	args: { attemptId: v.id('judgeAttempts'), leaseVersion: v.number() },
	handler: (ctx, args): Promise<void> =>
		runBackend(
			Effect.gen(function* () {
				yield* syncStep(assertCiDeployment);
				const claim = yield* step(ctx.runMutation(internal.judge._claim, args));
				if (!claim) return;
				// Exercise the real lease/completion/settlement protocol, replacing only
				// external judging. These are test verdicts, never calibration receipts.
				yield* step(
					ctx.runMutation(internal.judge._complete, {
						...args,
						result: {
							verdict: 'AC',
							phase: claim.kind === 'sample' ? 'sample' : 'hidden',
							sandboxSeconds: 0,
							actionSeconds: 0,
							...(claim.kind === 'sample'
								? {
										sampleResults: claim.samples.map((sample) => ({
											verdict: 'AC' as const,
											output: sample.output
										}))
									}
								: {})
						}
					})
				);
			})
		)
});
export const _terminate = internalAction({
	args: { sandboxId: v.string() },
	handler: () => {
		assertCiDeployment();
		return null;
	}
});
export const _reap = internalAction({
	args: {},
	handler: () => {
		assertCiDeployment();
		return null;
	}
});
