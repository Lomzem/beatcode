import { internalAction } from '../../convex/_generated/server';
import { v } from 'convex/values';
// A trusted action transport failure, before any controller callback.
export const _run = internalAction({
	args: { attemptId: v.id('judgeAttempts'), leaseVersion: v.number() },
	handler: async () => {
		throw new Error('Simulated controller transport failure');
	}
});
export { _terminate } from './trustedJudge.fixture';
