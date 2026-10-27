'use node';
import { Effect } from 'effect';
import { modalClient } from '../judge/modal';
import { JudgeFailure } from './game/effect';

/** SDK exceptions can include provider details; only fixed diagnostics cross this boundary. */
export const judgeCall = <A>(operation: () => PromiseLike<A>) =>
	Effect.tryPromise({ try: operation, catch: () => new JudgeFailure('JUDGE_TRANSPORT') });

/** Sandbox cleanup remains owned by judgeAttempt; the action owns its SDK connection. */
export function withModalClient<A, E>(
	use: (client: ReturnType<typeof modalClient>) => Effect.Effect<A, E>
) {
	return Effect.acquireUseRelease(
		Effect.try({ try: modalClient, catch: () => new JudgeFailure('MODAL_CONFIG') }),
		use,
		(client) =>
			Effect.try({ try: () => client.close(), catch: () => new JudgeFailure('MODAL_CLOSE') })
	);
}
