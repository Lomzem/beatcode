import { v } from 'convex/values';
export const cardId = v.union(
	v.literal('light_mode'),
	v.literal('no_paste'),
	v.literal('no_hints'),
	v.literal('brain_teaser'),
	v.literal('strict_compile')
);
export const profile = v.union(v.literal('std'), v.literal('strict'));
export const verdict = v.union(
	v.literal('AC'),
	v.literal('CE'),
	v.literal('WA'),
	v.literal('TLE'),
	v.literal('MLE'),
	v.literal('RE'),
	v.literal('OLE'),
	v.literal('IE')
);
export const limits = v.object({
	timeMs: v.number(),
	memoryMiB: v.number(),
	outputKiB: v.number(),
	aggregateMs: v.number()
});
export const samples = v.array(v.object({ input: v.string(), output: v.string() }));
export const snapshot = v.object({
	profile,
	problemVersionId: v.id('problemVersions'),
	judgeEnvId: v.id('judgeEnvironments'),
	sourceSha256: v.string(),
	testsSha256: v.string(),
	environmentSha256: v.string()
});
export const challenge = v.object({
	a: v.number(),
	b: v.number(),
	solvedAt: v.optional(v.number()),
	lastAnswerAt: v.optional(v.number())
});
export const sampleFeedback = v.object({
	input: v.string(),
	expected: v.string(),
	actual: v.string()
});

export const references = v.object({
	accepted: v.array(v.string()),
	timeLimitExceeded: v.array(v.string()),
	wrongAnswer: v.array(v.string()),
	validator: v.string()
});
export const ALL_HISTORY_POLICY = 'alpha-complexity-all-history-v1';
// Canonical decision contract; changing a bound requires a new named revision.
export const ALL_HISTORY_POLICY_SPEC =
	'alpha-complexity-all-history-v1;all-logical-history;accepted>=8,all-AC,complete-suite;per-test<=7500;aggregate<=7500;attempt<=15000;L=ceil100(max(500,2.5*maxAC))<=3000;slow>=8,all-AC-or-TLE,min>=2.5*L;validators=2;slow-sample=AC;all-WA;immutable-bindings;released;reviewed-empty-error-once;spread=diagnostic';
export const decisionPolicy = v.literal(ALL_HISTORY_POLICY);
export const calibration = v.object({
	decisionPolicy: v.optional(v.object({ name: decisionPolicy, policySha256: v.string() })),
	environmentSha256: v.string(),
	packageSha256: v.string(),
	evidenceSha256: v.string(),
	validatorPassed: v.boolean(),
	accepted: v.array(
		v.object({
			passed: v.array(v.boolean()),
			slowestTestMs: v.array(v.number()),
			aggregateMs: v.array(v.number()),
			attemptWallMs: v.array(v.number())
		})
	),
	timeLimitExceeded: v.array(
		v.object({ slowestTestMs: v.array(v.number()), passed: v.optional(v.array(v.boolean())) })
	),
	wrongAnswerFailed: v.array(v.boolean())
});
