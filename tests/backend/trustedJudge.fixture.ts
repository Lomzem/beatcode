import { internalAction } from '../../convex/_generated/server';
import { v } from 'convex/values';
// The trusted external judge is deliberately held pending. Tests deliver results
// via the real internal lease contract, and observe only authenticated public views.
export const _run = internalAction({
	args: { attemptId: v.id('judgeAttempts'), leaseVersion: v.number() },
	handler: async () => null
});
export const _terminate = internalAction({
	args: { sandboxId: v.string() },
	handler: async () => null
});
