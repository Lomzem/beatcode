import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	calibration,
	references,
	productionBaseline,
	productionApp,
	productionDecision
} from './game/validators';
import {
	cardId,
	limits,
	samples,
	snapshot,
	challenge,
	verdict,
	sampleFeedback
} from './game/validators';
export default defineSchema({
	usageDaily: defineTable({
		day: v.string(),
		playersCreated: v.number(),
		scored: v.number(),
		samples: v.number(),
		reservedSeconds: v.number(),
		actualSeconds: v.number(),
		actionSeconds: v.number()
	}).index('by_day', ['day']),
	decks: defineTable({
		roomId: v.id('rooms'),
		playerId: v.id('players'),
		cardIds: v.array(cardId),
		lockedForMatchId: v.optional(v.id('matches'))
	}).index('by_room_player', ['roomId', 'playerId']),
	matches: defineTable({
		roomId: v.id('rooms'),
		playerIds: v.array(v.id('players')),
		status: v.union(v.literal('active'), v.literal('finished')),
		wins: v.object({ a: v.number(), b: v.number() }),
		roundIndex: v.number(),
		voidCount: v.number(),
		problemPlan: v.array(v.id('problemVersions')),
		spareProblems: v.array(v.id('problemVersions')),
		result: v.optional(v.union(v.literal('win'), v.literal('draw'), v.literal('aborted'))),
		winnerId: v.optional(v.id('players')),
		reason: v.optional(v.string()),
		startedAt: v.number(),
		endedAt: v.optional(v.number()),
		sharedSource: v.object({ a: v.boolean(), b: v.boolean() })
	}),
	rounds: defineTable({
		matchId: v.id('matches'),
		index: v.number(),
		slot: v.number(),
		problemVersionId: v.id('problemVersions'),
		status: v.union(
			v.literal('intermission'),
			v.literal('active'),
			v.literal('settling'),
			v.literal('finished')
		),
		startsAt: v.number(),
		endsAt: v.number(),
		nextSeq: v.number(),
		readyNext: v.object({ a: v.boolean(), b: v.boolean() }),
		beginScheduledId: v.optional(v.id('_scheduled_functions')),
		outcome: v.optional(v.union(v.literal('won'), v.literal('drawn'), v.literal('void'))),
		winnerId: v.optional(v.id('players')),
		winningSubmissionId: v.optional(v.id('submissions')),
		decidedAt: v.optional(v.number())
	}).index('by_match_index', ['matchId', 'index']),
	roundPlayers: defineTable({
		roundId: v.id('rounds'),
		playerId: v.id('players'),
		power: v.number(),
		powerTick: v.number(),
		usedCards: v.array(cardId),
		lastPlayAt: v.optional(v.number()),
		lastSubmitAt: v.optional(v.number()),
		outstandingSubmissionId: v.optional(v.id('submissions')),
		outstandingSampleRunId: v.optional(v.id('sampleRuns')),
		lastSampleAt: v.optional(v.number()),
		scoredCount: v.number(),
		sampleCount: v.number()
	}).index('by_round_player', ['roundId', 'playerId']),
	effects: defineTable({
		roundId: v.id('rounds'),
		seq: v.number(),
		sourceId: v.id('players'),
		targetId: v.id('players'),
		cardId,
		startsAt: v.number(),
		endsAt: v.number(),
		clientPlayId: v.string(),
		consumedBySubmissionId: v.optional(v.id('submissions')),
		challenge: v.optional(challenge)
	})
		.index('by_round_target', ['roundId', 'targetId'])
		.index('by_round_source_client', ['roundId', 'sourceId', 'clientPlayId']),
	submissions: defineTable({
		roundId: v.id('rounds'),
		matchId: v.id('matches'),
		playerId: v.id('players'),
		seq: v.number(),
		receivedAt: v.number(),
		ceilingAt: v.number(),
		source: v.optional(v.string()),
		sourceBytes: v.number(),
		snapshot,
		clientSubmitId: v.string(),
		status: v.union(v.literal('pending'), v.literal('done'), v.literal('judge_failed')),
		verdict: v.optional(verdict),
		phase: v.optional(v.union(v.literal('sample'), v.literal('hidden'))),
		diagnostics: v.optional(v.string()),
		sampleFeedback: v.optional(sampleFeedback),
		sandboxTerminated: v.optional(v.boolean()),
		decidedAt: v.optional(v.number()),
		purgedAt: v.optional(v.number())
	})
		.index('by_round_seq', ['roundId', 'seq'])
		.index('by_player_client', ['playerId', 'clientSubmitId'])
		.index('by_player_received', ['playerId', 'receivedAt'])
		.index('by_problem_status_decided', ['snapshot.problemVersionId', 'status', 'decidedAt'])
		.index('by_player_status', ['playerId', 'status']),
	sampleRuns: defineTable({
		roundId: v.id('rounds'),
		playerId: v.id('players'),
		source: v.optional(v.string()),
		createdAt: v.number(),
		status: v.union(v.literal('pending'), v.literal('done'), v.literal('judge_failed')),
		clientRunId: v.string(),
		snapshot,
		results: v.optional(v.array(v.object({ verdict, output: v.string() }))),
		diagnostics: v.optional(v.string()),
		purgedAt: v.optional(v.number())
	})
		.index('by_round_player', ['roundId', 'playerId'])
		.index('by_player_client', ['playerId', 'clientRunId'])
		.index('by_player_created', ['playerId', 'createdAt'])
		.index('by_player_status', ['playerId', 'status']),
	judgeAttempts: defineTable({
		kind: v.union(v.literal('scored'), v.literal('sample')),
		submissionId: v.optional(v.id('submissions')),
		sampleRunId: v.optional(v.id('sampleRuns')),
		attemptNo: v.number(),
		status: v.union(
			v.literal('queued'),
			v.literal('dispatched'),
			v.literal('running'),
			v.literal('cleaning'),
			v.literal('done'),
			v.literal('ie'),
			v.literal('lease_expired')
		),
		leaseVersion: v.number(),
		ceilingAt: v.number(),
		sandboxId: v.optional(v.string()),
		// Ownership is recorded before the SDK create can be sent. A missing ID is
		// ambiguous until the controller or tagged reaper recovers the resource.
		createStartedAt: v.optional(v.number()),
		sandboxObservedAt: v.optional(v.number()),
		cleanupConfirmedAt: v.optional(v.number()),
		cleanupForceTerminal: v.optional(v.boolean()),
		cleanupLeaseExpired: v.optional(v.boolean()),
		reservedSeconds: v.number(),
		sandboxSeconds: v.optional(v.number()),
		actionSeconds: v.optional(v.number()),
		createdAt: v.number(),
		finishedAt: v.optional(v.number()),
		contestantStartedAt: v.optional(v.number()),
		stage: v.optional(v.union(v.literal('compile'), v.literal('run'))),
		failureClass: v.optional(
			v.union(v.literal('contestant'), v.literal('platform'), v.literal('sandbox_lost'))
		),
		lossAt: v.optional(v.number()),
		lossVerdict: v.optional(
			v.union(v.literal('CE'), v.literal('TLE'), v.literal('MLE'), v.literal('RE'))
		),
		purgedAt: v.optional(v.number()),
		metrics: v.optional(
			v.object({ testWallMs: v.array(v.number()), execObservedMs: v.array(v.number()) })
		),
		reservationDay: v.optional(v.string()),
		reservationMonth: v.optional(v.string())
	})
		.index('by_status_kind_ceiling', ['status', 'kind', 'ceilingAt'])
		.index('by_submission', ['submissionId'])
		.index('by_sample', ['sampleRunId'])
		.index('by_sandbox', ['sandboxId']),
	infraIncidents: defineTable({
		at: v.number(),
		source: v.union(v.literal('platform'), v.literal('operator')),
		attemptId: v.optional(v.id('judgeAttempts')),
		code: v.string(),
		note: v.optional(v.string())
	}).index('by_at', ['at']),
	problems: defineTable({
		slug: v.string(),
		title: v.string(),
		difficulty: v.union(v.literal(1), v.literal(2), v.literal(3)),
		activeVersionId: v.optional(v.id('problemVersions')),
		retired: v.boolean()
	}).index('by_slug', ['slug']),
	problemVersions: defineTable({
		problemId: v.id('problems'),
		version: v.number(),
		statementMd: v.string(),
		samples,
		limits,
		testsStorageId: v.id('_storage'),
		testsSha256: v.string(),
		packageSha256: v.string(),
		referenceSolutions: v.optional(references),
		calibration: v.optional(calibration),
		productionBaseline: v.optional(productionBaseline),
		productionDecision: v.optional(productionDecision),
		judgeEnvId: v.id('judgeEnvironments'),
		status: v.union(
			v.literal('draft'),
			v.literal('calibrating'),
			v.literal('active'),
			v.literal('rejected')
		)
	}).index('by_problem_version', ['problemId', 'version']),
	playerProblemExposure: defineTable({
		playerId: v.id('players'),
		problemId: v.id('problems'),
		at: v.number()
	}).index('by_player', ['playerId']),
	judgeEnvironments: defineTable({
		productionApp: v.optional(productionApp),
		envId: v.string(),
		modalImageId: v.string(),
		baseDigest: v.string(),
		gccVersion: v.string(),
		runtime: v.union(v.literal('gvisor'), v.literal('vm')),
		cpu: v.number(),
		runnerSha256: v.string(),
		status: v.union(v.literal('active'), v.literal('retired'))
	}).index('by_env', ['envId']),
	usageMonthly: defineTable({
		month: v.string(),
		actualSeconds: v.number(),
		actionSeconds: v.number(),
		reservedSeconds: v.number()
	}).index('by_month', ['month']),
	ops: defineTable({
		key: v.literal('global'),
		judgingEnabled: v.boolean(),
		maxInFlight: v.number(),
		inFlight: v.number(),
		dailySecondsCap: v.number(),
		monthlySecondsCap: v.number(),
		monthlyActionSecondsCap: v.number(),
		updatedAt: v.number()
	}).index('by_key', ['key']),
	auditLog: defineTable({
		at: v.number(),
		kind: v.string(),
		actor: v.optional(v.id('players')),
		refId: v.optional(v.string()),
		detail: v.string()
	}).index('by_kind', ['kind']),
	hostPasses: defineTable({
		codeHash: v.string(),
		note: v.string(),
		createdAt: v.number(),
		expiresAt: v.number(),
		redeemedBy: v.optional(v.id('players')),
		redeemedAt: v.optional(v.number())
	}).index('by_hash', ['codeHash']),
	rooms: defineTable({
		hostId: v.id('players'),
		guestId: v.optional(v.id('players')),
		inviteHash: v.optional(v.string()),
		inviteExpiresAt: v.optional(v.number()),
		inviteFailures: v.number(),
		status: v.union(
			v.literal('open'),
			v.literal('lobby'),
			v.literal('in_match'),
			v.literal('results'),
			v.literal('closed')
		),
		ready: v.object({ host: v.boolean(), guest: v.boolean() }),
		rematch: v.object({ host: v.boolean(), guest: v.boolean() }),
		startScheduledId: v.optional(v.id('_scheduled_functions')),
		currentMatchId: v.optional(v.id('matches')),
		lastSeen: v.object({ host: v.number(), guest: v.optional(v.number()) })
	})
		.index('by_host', ['hostId'])
		.index('by_guest', ['guestId'])
		.index('by_status', ['status']),
	players: defineTable({
		tokenIdentifier: v.string(),
		displayName: v.string(),
		canHost: v.boolean(),
		disabled: v.boolean(),
		createdAt: v.number(),
		failedJoins: v.optional(v.object({ windowStart: v.number(), count: v.number() }))
	}).index('by_token', ['tokenIdentifier'])
});
