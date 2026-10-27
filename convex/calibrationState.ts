import { EXECUTION_POLICY } from '../shared/calibrationDeployment';
import { deploymentConfig } from './calibrationConfig';
import { Effect } from 'effect';
import { runBackend, step, CalibrationFailure } from './game/effect';
import { v } from 'convex/values';
import { decisionPolicy } from './game/validators';
import { internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { settings, daily, monthly } from './game/usage';
import { sha256 } from './game/binding';
import { serializeEnvironment } from '../shared/environment';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';

// Fixed deployment campaigns. All reservations are fully charged, including crashes.
// auditLog is private operator storage; this campaign must finish within its 30d retention.

// Keep the campaign ledger/cost cap across policy revisions. Legacy receipts remain charged.
export { EXECUTION_POLICY } from '../shared/calibrationDeployment';
export const role = v.union(
	v.literal('validator'),
	v.literal('accepted'),
	v.literal('timeLimitExceeded'),
	v.literal('wrongAnswer'),
	v.literal('slowSample')
);
// Only controller-owned fixed codes may enter private diagnostic receipts.
const diagnostic = v.union(
	v.object({ failureClass: v.literal('platform'), code: v.literal('CONTROLLER_PREFLIGHT') }),
	v.object({
		failureClass: v.literal('sandbox_lost'),
		code: v.literal('EXEC_LOST'),
		timedOut: v.boolean(),
		lowMemory: v.boolean()
	})
);
export type CalibrationDiagnostic =
	| { failureClass: 'platform'; code: 'CONTROLLER_PREFLIGHT' }
	| { failureClass: 'sandbox_lost'; code: 'EXEC_LOST'; timedOut: boolean; lowMemory: boolean };
export interface Measurement {
	failure?: CalibrationDiagnostic;
	verdict: string;
	slowestTestMs: number;
	aggregateMs: number;
	attemptWallMs: number;
	testWallMs: number[];
	execObservedMs: number[];
	sandboxSeconds: number;
	actionSeconds: number;
	sourceSha256: string;
	executionTestsSha256: string;
}
export const retryApproval = v.literal('reviewed-empty-error-once');
export interface Entry {
	decisionPolicy?: 'alpha-complexity-all-history-v1';
	deployment?: string;
	appId?: string;
	retryOf?: Id<'auditLog'>;
	retryApproval?: 'reviewed-empty-error-once';
	environmentSha256?: string;
	// Diagnostic only: cleanup-held receipts still have no publishable result.
	failure?: CalibrationDiagnostic;
	creation?: 'reserved' | 'creating' | 'known' | 'stopped';
	sandboxId?: string;
	expired?: boolean;
	executionPolicy?: string;
	problemVersionId: string;
	role: string;
	index: number;
	repeat: number;
	sourceSha256: string;
	packageSha256: string;
	testsSha256: string;
	day: string;
	month: string;
	deadline: number;
	released: boolean;
	result?: Measurement;
}
// ERROR is missing evidence, never a synthetic TLE or a performance sample.
function emptyError(e: Entry) {
	const r = e.result;
	return (
		e.creation === 'stopped' &&
		e.released &&
		!e.expired &&
		r?.verdict === 'ERROR' &&
		r.testWallMs.length === 0 &&
		r.execObservedMs.length === 0 &&
		r.slowestTestMs === 0 &&
		r.aggregateMs === 0 &&
		r.attemptWallMs === 0
	);
}
function sameSample(a: Entry, b: Entry) {
	return (
		a.problemVersionId === b.problemVersionId &&
		a.role === b.role &&
		a.index === b.index &&
		a.repeat === b.repeat &&
		a.sourceSha256 === b.sourceSha256 &&
		a.packageSha256 === b.packageSha256 &&
		a.testsSha256 === b.testsSha256 &&
		(!a.environmentSha256 || a.environmentSha256 === b.environmentSha256)
	);
}
// Both admission and finalization use the same logical samples. Physical receipts stay intact.
export function logicalSamples<T extends Entry & { reservationId: Id<'auditLog'> }>(
	jobs: T[]
): Effect.Effect<T[], CalibrationFailure> {
	return Effect.gen(function* () {
		const primaries = jobs.filter((j) => !j.retryOf);
		for (const retry of jobs.filter((j) => j.retryOf)) {
			const primary = primaries.find((j) => j.reservationId === retry.retryOf);
			if (
				!primary ||
				!emptyError(primary) ||
				!sameSample(primary, retry) ||
				retry.retryApproval !== 'reviewed-empty-error-once' ||
				jobs.filter((j) => j.retryOf === primary.reservationId).length !== 1
			)
				return yield* Effect.fail(new CalibrationFailure('CALIBRATION_RETRY_NOT_ALLOWED'));
		}
		return primaries.map(
			(primary) => jobs.find((j) => j.retryOf === primary.reservationId) ?? primary
		);
	});
}
function entries(ctx: MutationCtx | QueryCtx) {
	return Effect.gen(function* () {
		const { campaign: KIND, maxJobs: MAX_JOBS } = yield* deploymentConfig();
		const rows = yield* step(
			ctx.db
				.query('auditLog')
				.withIndex('by_kind', (q) => q.eq('kind', KIND))
				.take(MAX_JOBS + 1)
		);
		if (rows.length > MAX_JOBS)
			return yield* Effect.fail(new CalibrationFailure('CALIBRATION_LEDGER_OVERFLOW'));
		return rows.map((row) => ({ row, entry: JSON.parse(row.detail) as Entry }));
	});
}
export const _reserve = internalMutation({
	args: {
		problemVersionId: v.id('problemVersions'),
		role,
		index: v.number(),
		repeat: v.number(),
		sourceSha256: v.string(),
		retryOf: v.optional(v.id('auditLog')),
		retryApproval: v.optional(retryApproval),
		decisionPolicy: v.optional(decisionPolicy)
	},
	handler: (ctx, args): Promise<Id<'auditLog'>> =>
		runBackend(
			Effect.gen(function* () {
				const config = yield* deploymentConfig(true);
				const { campaign: KIND, maxJobs: MAX_JOBS } = config;
				if (
					!Number.isInteger(args.index) ||
					args.index < 0 ||
					(args.role === 'validator' && (args.index > 1 || args.repeat !== 0)) ||
					!Number.isInteger(args.repeat) ||
					args.repeat < 0 ||
					args.repeat > (args.role === 'accepted' ? 15 : 7)
				)
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_JOB'));
				const p = yield* step(ctx.db.get(args.problemVersionId));
				if (
					!p ||
					!['draft', 'calibrating', ...(args.decisionPolicy ? ['rejected'] : [])].includes(
						p.status
					) ||
					!p.referenceSolutions
				)
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_VERSION'));
				const refs = p.referenceSolutions;
				const source =
					args.role === 'validator'
						? refs.validator
						: args.role === 'slowSample'
							? refs.timeLimitExceeded[args.index]
							: refs[args.role][args.index];
				if (!source || (yield* sha256(source)) !== args.sourceSha256)
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_SOURCE'));
				const ledger = yield* entries(ctx),
					ops = yield* settings(ctx),
					d = yield* daily(ctx),
					m = yield* monthly(ctx);
				if (
					ledger.some(
						({ entry }) =>
							entry.problemVersionId === p._id && entry.executionPolicy !== EXECUTION_POLICY
					)
				)
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_POLICY'));
				const environment = yield* step(ctx.db.get(p.judgeEnvId));
				if (!environment || environment.status !== 'active')
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_VERSION'));
				if (
					config.production &&
					(!environment.productionApp || !p.productionBaseline || !args.decisionPolicy)
				)
					return yield* Effect.fail(new CalibrationFailure('PRODUCTION_BASELINE_REQUIRED'));
				const environmentSha256 = yield* sha256(serializeEnvironment(environment));
				if (args.retryOf) {
					const primary = ledger.find((x) => x.row._id === args.retryOf)?.entry;
					if (
						!primary ||
						primary.retryOf ||
						!emptyError(primary) ||
						args.retryApproval !== 'reviewed-empty-error-once' ||
						!sameSample(primary, {
							...primary,
							...args,
							packageSha256: p.packageSha256,
							testsSha256: p.testsSha256,
							environmentSha256
						}) ||
						ledger.some((x) => x.entry.retryOf === args.retryOf)
					)
						return yield* Effect.fail(new CalibrationFailure('CALIBRATION_RETRY_NOT_ALLOWED'));
				} else if (args.retryApproval) {
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_RETRY_NOT_ALLOWED'));
				}
				if (args.decisionPolicy && args.role === 'accepted' && args.repeat >= 8 && !args.retryOf)
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_RETRY_NOT_ALLOWED'));
				if (!args.retryOf && args.role === 'accepted' && args.repeat >= 8) {
					const logical = yield* logicalSamples(
						ledger.map((x) => ({ ...x.entry, reservationId: x.row._id }))
					);
					const first = logical
						.map((entry) => ({ entry }))
						.filter(
							({ entry: e }) =>
								e.problemVersionId === p._id &&
								e.role === 'accepted' &&
								e.index === args.index &&
								e.repeat < 8
						);
					const times = first.flatMap((x) =>
						x.entry.result ? [x.entry.result.slowestTestMs] : []
					);
					if (
						times.length !== 8 ||
						first.some((x) => x.entry.result?.verdict !== 'AC') ||
						Math.max(...times) / Math.min(...times) <= 2
					)
						return yield* Effect.fail(new CalibrationFailure('CALIBRATION_RETRY_NOT_ALLOWED'));
				}
				if (
					!args.retryOf &&
					ledger.some(
						({ entry: e }) =>
							e.problemVersionId === p._id &&
							e.role === args.role &&
							e.index === args.index &&
							e.repeat === args.repeat
					)
				)
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_DUPLICATE'));
				if (
					ledger.length >= MAX_JOBS ||
					ledger.filter((x) => !x.entry.released).length >= 2 ||
					ops.inFlight >= Math.min(2, ops.maxInFlight)
				)
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_CAPACITY'));
				if (
					d.actualSeconds + d.reservedSeconds + 40 > ops.dailySecondsCap ||
					m.actualSeconds + m.reservedSeconds + 40 > ops.monthlySecondsCap ||
					m.actionSeconds + (ops.inFlight + 1) * 600 > ops.monthlyActionSecondsCap
				)
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_BUDGET'));
				// No refunds: fixed campaign jobs * 40 seconds; conservatively charge 600 action seconds per job.
				yield* step(
					ctx.db.patch(d._id, {
						actualSeconds: d.actualSeconds + 40,
						actionSeconds: d.actionSeconds + 600
					})
				);
				yield* step(
					ctx.db.patch(m._id, {
						actualSeconds: m.actualSeconds + 40,
						actionSeconds: m.actionSeconds + 600
					})
				);
				yield* step(ctx.db.patch(ops._id, { inFlight: ops.inFlight + 1 }));
				const entry: Entry = {
					...args,
					...(config.production
						? { deployment: config.deployment, appId: environment.productionApp!.appId }
						: {}),
					environmentSha256,
					executionPolicy: EXECUTION_POLICY,
					creation: 'reserved',
					packageSha256: p.packageSha256,
					testsSha256: p.testsSha256,
					day: d.day,
					month: m.month,
					deadline: Date.now() + 600000,
					released: false
				};
				const id = yield* step(
					ctx.db.insert('auditLog', {
						at: Date.now(),
						kind: KIND,
						refId: p._id,
						detail: JSON.stringify(entry)
					})
				);
				yield* step(
					ctx.scheduler.runAfter(600000, internal.calibrationState._expire, { reservationId: id })
				);
				return id;
			})
		)
});
const measurement = v.object({
	failure: v.optional(diagnostic),
	verdict: v.string(),
	slowestTestMs: v.number(),
	aggregateMs: v.number(),
	attemptWallMs: v.number(),
	testWallMs: v.array(v.number()),
	execObservedMs: v.array(v.number()),
	sandboxSeconds: v.number(),
	actionSeconds: v.number(),
	sourceSha256: v.string(),
	executionTestsSha256: v.string()
});
function release(ctx: MutationCtx, id: Id<'auditLog'>, result?: Measurement) {
	return Effect.gen(function* () {
		const { campaign: KIND } = yield* deploymentConfig();
		const row = yield* step(ctx.db.get(id));
		if (!row || row.kind !== KIND)
			return yield* Effect.fail(new CalibrationFailure('CALIBRATION_RESERVATION'));
		const e = JSON.parse(row.detail) as Entry;
		if (e.released) return;
		// No timeout or missing list result proves a pending remote create is dead.
		if (e.creation !== 'reserved' && e.creation !== 'stopped') return;
		if (e.expired || e.deadline <= Date.now()) {
			e.expired = true;
			result = undefined;
		}
		const ops = yield* settings(ctx);
		yield* step(ctx.db.patch(ops._id, { inFlight: Math.max(0, ops.inFlight - 1) }));
		// Keep full 40s on every outcome, but replace the conservative action charge on acknowledged completion.
		if (result) {
			const values = [
				result.slowestTestMs,
				result.aggregateMs,
				result.attemptWallMs,
				result.sandboxSeconds,
				result.actionSeconds,
				...result.testWallMs,
				...result.execObservedMs
			];
			if (
				values.some((x) => !Number.isFinite(x) || x < 0) ||
				result.actionSeconds > 600 ||
				result.sandboxSeconds > 40 ||
				result.testWallMs.length > 53
			)
				return yield* Effect.fail(new CalibrationFailure('CALIBRATION_METRICS'));
			for (const usage of [yield* daily(ctx, e.day), yield* monthly(ctx, e.month)])
				yield* step(
					ctx.db.patch(usage._id, {
						actionSeconds: usage.actionSeconds - 600 + result.actionSeconds
					})
				);
		}
		yield* step(
			ctx.db.patch(id, {
				detail: JSON.stringify({ ...e, released: true, ...(result ? { result } : {}) })
			})
		);
	});
}
export const _finish = internalMutation({
	args: { reservationId: v.id('auditLog'), result: measurement },
	handler: (ctx, a) =>
		runBackend(
			Effect.gen(function* () {
				const { campaign: KIND } = yield* deploymentConfig();
				const row = yield* step(ctx.db.get(a.reservationId));
				if (row?.kind === KIND && a.result.failure) {
					const entry = JSON.parse(row.detail) as Entry;
					if (!entry.released && !entry.expired && entry.deadline > Date.now())
						yield* step(
							ctx.db.patch(row._id, {
								detail: JSON.stringify({ ...entry, failure: a.result.failure })
							})
						);
				}
				return yield* release(ctx, a.reservationId, a.result);
			})
		)
});
export const _expire = internalMutation({
	args: { reservationId: v.id('auditLog') },
	handler: (ctx, a): Promise<void> =>
		runBackend(
			Effect.gen(function* () {
				const { campaign: KIND } = yield* deploymentConfig();
				const row = yield* step(ctx.db.get(a.reservationId));
				if (!row || row.kind !== KIND) return;
				const e = JSON.parse(row.detail) as Entry;
				if (e.released || e.deadline > Date.now()) return;
				yield* step(ctx.db.patch(row._id, { detail: JSON.stringify({ ...e, expired: true }) }));
				if (e.creation === 'known' || e.creation === 'creating')
					yield* step(
						ctx.scheduler.runAfter(
							0,
							e.creation === 'known'
								? internal.calibration._cleanup
								: internal.calibration._reconcile,
							a
						)
					);
				yield* release(ctx, a.reservationId);
			})
		)
});
export const _status = internalQuery({
	args: {},
	handler: (ctx) =>
		runBackend(
			Effect.gen(function* () {
				const ledger = yield* entries(ctx);
				const ops = yield* step(
					ctx.db
						.query('ops')
						.withIndex('by_key', (q) => q.eq('key', 'global'))
						.unique()
				);
				return {
					...(yield* deploymentConfig()),
					sharedInFlight: ops?.inFlight ?? 0,
					executionPolicy: EXECUTION_POLICY,
					reservedSeconds: ledger.length * 40,
					creditEstimate: ledger.length * 40 * 0.0000478,
					pending: ledger.filter((x) => !x.entry.released).length,
					jobs: ledger.map(({ row, entry }) => ({ reservationId: row._id, ...entry }))
				};
			})
		)
});
// Authenticated liveness acknowledgements keep calibration transport representative of judging.
export const _alive = internalMutation({
	args: { reservationId: v.id('auditLog') },
	handler: (ctx, a) =>
		runBackend(
			Effect.gen(function* () {
				const { campaign: KIND } = yield* deploymentConfig();
				const row = yield* step(ctx.db.get(a.reservationId));
				if (!row || row.kind !== KIND) return false;
				const e = JSON.parse(row.detail) as Entry;
				return !e.released && e.deadline > Date.now();
			})
		)
});

// Durable one-shot dispatch fence. Unknown outcomes are intentionally not reset or retried.
export const _creating = internalMutation({
	args: { reservationId: v.id('auditLog') },
	handler: (ctx, a): Promise<boolean> =>
		runBackend(
			Effect.gen(function* () {
				const { campaign: KIND } = yield* deploymentConfig();
				const row = yield* step(ctx.db.get(a.reservationId));
				if (!row || row.kind !== KIND) return false;
				const e = JSON.parse(row.detail) as Entry;
				if (e.released || e.expired || e.deadline <= Date.now() || e.creation !== 'reserved')
					return false;
				yield* step(
					ctx.db.patch(row._id, { detail: JSON.stringify({ ...e, creation: 'creating' }) })
				);
				return true;
			})
		)
});
export const _created = internalMutation({
	args: { reservationId: v.id('auditLog'), sandboxId: v.string() },
	handler: (ctx, a): Promise<boolean> =>
		runBackend(
			Effect.gen(function* () {
				const { campaign: KIND } = yield* deploymentConfig();
				const row = yield* step(ctx.db.get(a.reservationId));
				if (!row || row.kind !== KIND || !/^sb-[0-9A-Za-z]{22}$/.test(a.sandboxId))
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_RESERVATION'));
				const e = JSON.parse(row.detail) as Entry;
				if (
					(e.creation !== 'creating' && e.sandboxId !== a.sandboxId) ||
					(e.sandboxId && e.sandboxId !== a.sandboxId)
				)
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_RESERVATION'));
				if (e.creation === 'stopped') return false;
				if (e.creation === 'known') return !e.expired && e.deadline > Date.now() && !e.released;
				const expired = e.expired || e.deadline <= Date.now();
				yield* step(
					ctx.db.patch(row._id, {
						detail: JSON.stringify({ ...e, creation: 'known', sandboxId: a.sandboxId, expired })
					})
				);
				// Queue cleanup at the deadline even if the owning action dies after this acknowledgement.
				yield* step(
					ctx.scheduler.runAfter(
						expired ? 0 : Math.max(0, e.deadline - Date.now()),
						internal.calibration._cleanup,
						{ reservationId: a.reservationId }
					)
				);
				return !expired && !e.released;
			})
		)
});
export const _terminated = internalMutation({
	args: { reservationId: v.id('auditLog'), sandboxId: v.string() },
	handler: (ctx, a): Promise<void> =>
		runBackend(
			Effect.gen(function* () {
				const { campaign: KIND } = yield* deploymentConfig();
				const row = yield* step(ctx.db.get(a.reservationId));
				if (!row || row.kind !== KIND) return;
				const e = JSON.parse(row.detail) as Entry;
				if (e.sandboxId !== a.sandboxId || !['known', 'stopped'].includes(e.creation ?? ''))
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_RESERVATION'));
				if (e.creation === 'stopped') return;
				const expired = e.expired || e.deadline <= Date.now();
				yield* step(
					ctx.db.patch(row._id, { detail: JSON.stringify({ ...e, creation: 'stopped', expired }) })
				);
				if (expired) yield* release(ctx, row._id);
			})
		)
});
export const _cleanupTarget = internalQuery({
	args: { reservationId: v.id('auditLog') },
	handler: (ctx, a): Promise<{ sandboxId: string; appId?: string } | null> =>
		runBackend(
			Effect.gen(function* () {
				const { campaign: KIND } = yield* deploymentConfig();
				const row = yield* step(ctx.db.get(a.reservationId));
				if (!row || row.kind !== KIND) return null;
				const e = JSON.parse(row.detail) as Entry;
				return !e.released && e.creation === 'known' && e.sandboxId
					? { sandboxId: e.sandboxId, ...(e.appId ? { appId: e.appId } : {}) }
					: null;
			})
		)
});
