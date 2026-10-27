import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import production from '../../../convex/schema';
export const recoveryIntent = v.object({
	runId: v.string(),
	startedAt: v.number(),
	backend: v.string(),
	accountId: v.string(),
	requestedAt: v.number(),
	state: v.union(
		v.literal('planned'),
		v.literal('created'),
		v.literal('rejected'),
		v.literal('deleted')
	),
	clerkId: v.optional(v.string())
});
export default defineSchema({
	...production.tables,
	ciAccountRecovery: defineTable(recoveryIntent).index('by_account', ['accountId'])
});
