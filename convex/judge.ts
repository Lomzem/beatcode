import { Effect } from 'effect';
import { runBackend, step, reject } from './game/effect';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { daily, monthly, settings } from './game/usage';
import {
	expireAttempt,
	failAttempt,
	finishSubmission,
	finishCleanup,
	release
} from './game/judging';
import { enforceTimingPolicy } from './game/timing';
import { sampleFeedback, verdict } from './game/validators';
export const _pump = internalMutation({
	args: {},
	handler: (ctx): Promise<{ attemptId: Id<'judgeAttempts'>; leaseVersion: number }[]> =>
		runBackend(
			Effect.gen(function* () {
				const ops = yield* settings(ctx);
				const dispatched: { attemptId: Id<'judgeAttempts'>; leaseVersion: number }[] = [];
				if (!ops.judgingEnabled) return dispatched;
				const attempts = yield* step(
					ctx.db
						.query('judgeAttempts')
						.withIndex('by_status_kind_ceiling', (q) => q.eq('status', 'queued'))
						.collect()
				);
				attempts.sort(
					(a, b) =>
						Number(a.kind === 'sample') - Number(b.kind === 'sample') ||
						a.ceilingAt - b.ceilingAt ||
						a._creationTime - b._creationTime
				);
				let inFlight = ops.inFlight;
				for (const attempt of attempts) {
					if (inFlight >= ops.maxInFlight) break;
					if (Date.now() >= attempt.ceilingAt) {
						yield* expireAttempt(ctx, attempt, 'QUEUE_CEILING');
						continue;
					}
					const d = yield* daily(ctx),
						m = yield* monthly(ctx);
					if (
						d.actualSeconds + d.reservedSeconds + 40 > ops.dailySecondsCap ||
						m.actualSeconds + m.reservedSeconds + 40 > ops.monthlySecondsCap ||
						m.actionSeconds + (inFlight + 1) * 45 > ops.monthlyActionSecondsCap
					) {
						yield* step(ctx.db.patch(ops._id, { judgingEnabled: false, updatedAt: Date.now() }));
						yield* step(
							ctx.db.insert('auditLog', {
								at: Date.now(),
								kind: 'cap_trip',
								detail: 'Judge budget cap reached'
							})
						);
						break;
					}
					const leaseVersion = attempt.leaseVersion + 1;
					yield* step(
						ctx.db.patch(attempt._id, {
							status: 'dispatched',
							leaseVersion,
							reservedSeconds: 40,
							reservationDay: d.day,
							reservationMonth: m.month
						})
					);
					yield* step(ctx.db.patch(d._id, { reservedSeconds: d.reservedSeconds + 40 }));
					yield* step(ctx.db.patch(m._id, { reservedSeconds: m.reservedSeconds + 40 }));
					inFlight++;
					const job = { attemptId: attempt._id, leaseVersion };
					dispatched.push(job);
					yield* step(ctx.scheduler.runAfter(0, internal.judgeDispatch._run, job));
					yield* step(ctx.scheduler.runAfter(45000, internal.judge._watchdog, job));
				}
				yield* step(ctx.db.patch(ops._id, { inFlight }));
				return dispatched;
			})
		)
});
const lease = { attemptId: v.id('judgeAttempts'), leaseVersion: v.number() };
export const _claim = internalMutation({
	args: lease,
	handler: (ctx, args) =>
		runBackend(
			Effect.gen(function* () {
				const a = yield* step(ctx.db.get(args.attemptId));
				if (
					!a ||
					a.status !== 'dispatched' ||
					a.leaseVersion !== args.leaseVersion ||
					Date.now() >= a.ceilingAt
				)
					return null;
				const s = a.submissionId
					? yield* step(ctx.db.get(a.submissionId))
					: a.sampleRunId
						? yield* step(ctx.db.get(a.sampleRunId))
						: null;
				if (!s || s.status !== 'pending' || s.source === undefined) return null;
				const p = yield* step(ctx.db.get(s.snapshot.problemVersionId)),
					environment = yield* step(ctx.db.get(s.snapshot.judgeEnvId));
				if (!p || !environment || p.judgeEnvId !== s.snapshot.judgeEnvId) return null;
				yield* step(ctx.db.patch(a._id, { status: 'running' }));
				return {
					kind: a.kind,
					submissionId: a.submissionId ?? null,
					sampleRunId: a.sampleRunId ?? null,
					source: s.source,
					sourceSha256: s.snapshot.sourceSha256,
					testsSha256: p.testsSha256,
					snapshot: s.snapshot,
					limits: p.limits,
					samples: p.samples,
					...(a.kind === 'scored' ? { testsStorageId: p.testsStorageId } : {}),
					environment,
					ceilingAt: a.ceilingAt
				};
			})
		)
});
/** Fence create before network I/O; cleaning/late deliveries cannot allocate. */
export const _beginCreate = internalMutation({
	args: lease,
	handler: (ctx, args) =>
		runBackend(
			Effect.gen(function* () {
				const a = yield* step(ctx.db.get(args.attemptId));
				if (
					!a ||
					a.status !== 'running' ||
					a.leaseVersion !== args.leaseVersion ||
					a.createStartedAt !== undefined ||
					a.sandboxId !== undefined ||
					a.cleanupConfirmedAt !== undefined ||
					Date.now() >= a.ceilingAt
				)
					return false;
				yield* step(ctx.db.patch(a._id, { createStartedAt: Date.now() }));
				return true;
			})
		)
});
export const _checkCleanup = internalMutation({
	args: lease,
	handler: (ctx, args) =>
		runBackend(
			Effect.gen(function* () {
				const a = yield* step(ctx.db.get(args.attemptId));
				if (a && a.leaseVersion === args.leaseVersion) yield* finishCleanup(ctx, a);
			})
		)
});
/** Called only by trusted actions after SDK termination AND poll confirms exit. */
export const _confirmSandboxCleanup = internalMutation({
	args: { sandboxId: v.string(), lease: v.optional(v.object(lease)) },
	handler: (ctx, args) =>
		runBackend(
			Effect.gen(function* () {
				if (!/^sb-[0-9A-Za-z]{22}$/.test(args.sandboxId)) return;
				const attempts = args.lease
					? [yield* step(ctx.db.get(args.lease.attemptId))]
					: yield* step(
							ctx.db
								.query('judgeAttempts')
								.withIndex('by_sandbox', (q) => q.eq('sandboxId', args.sandboxId))
								.collect()
						);
				for (const a of attempts) {
					if (
						!a ||
						!['running', 'cleaning'].includes(a.status) ||
						a.cleanupConfirmedAt !== undefined ||
						(args.lease && a.leaseVersion !== args.lease.leaseVersion) ||
						(a.sandboxId && a.sandboxId !== args.sandboxId)
					)
						continue;
					// The controller may have terminated successfully even when delivery
					// of _noteSandbox failed. Its lease-bound exit receipt still owns cleanup.
					const confirmed = { ...a, sandboxId: args.sandboxId, cleanupConfirmedAt: Date.now() };
					yield* step(
						ctx.db.patch(a._id, {
							sandboxId: args.sandboxId,
							cleanupConfirmedAt: confirmed.cleanupConfirmedAt
						})
					);
					yield* finishCleanup(ctx, confirmed);
				}
			})
		)
});
export const _noteSandbox = internalMutation({
	args: { ...lease, sandboxId: v.string(), creationConfirmed: v.optional(v.boolean()) },
	handler: (ctx, args): Promise<boolean> =>
		runBackend(
			Effect.gen(function* () {
				const a = yield* step(ctx.db.get(args.attemptId));
				if (
					!a ||
					!['running', 'cleaning'].includes(a.status) ||
					a.leaseVersion !== args.leaseVersion
				)
					return false;
				if (a.sandboxId && a.sandboxId !== args.sandboxId) return false;
				if (!/^sb-[0-9A-Za-z]{22}$/.test(args.sandboxId)) return false;
				yield* step(
					ctx.db.patch(a._id, {
						sandboxId: args.sandboxId,
						...(args.creationConfirmed !== false
							? { sandboxObservedAt: a.sandboxObservedAt ?? Date.now() }
							: {})
					})
				);
				if (a.status === 'running' && Date.now() >= a.ceilingAt) {
					yield* expireAttempt(ctx, (yield* step(ctx.db.get(a._id)))!, 'CREATE_AFTER_CEILING');
					return false;
				}
				if (a.status === 'cleaning') {
					// Recover cleanup ownership without reattaching execution authority.
					yield* step(
						ctx.scheduler.runAfter(0, internal.judgeDispatch._terminate, {
							sandboxId: args.sandboxId
						})
					);
					yield* finishCleanup(ctx, (yield* step(ctx.db.get(a._id)))!);
					return false;
				}
				return true;
			})
		)
});
export const _noteContestantStart = internalMutation({
	args: { ...lease, stage: v.union(v.literal('compile'), v.literal('run')) },
	handler: (ctx, args) =>
		runBackend(
			Effect.gen(function* () {
				const a = yield* step(ctx.db.get(args.attemptId));
				if (!a || a.status !== 'running' || a.leaseVersion !== args.leaseVersion) return false;
				if (Date.now() >= a.ceilingAt) {
					yield* expireAttempt(ctx, a, 'EXEC_AFTER_CEILING');
					return false;
				}
				yield* step(
					ctx.db.patch(a._id, {
						contestantStartedAt: a.contestantStartedAt ?? Date.now(),
						stage: args.stage
					})
				);
				return true;
			})
		)
});
export const _complete = internalMutation({
	args: {
		...lease,
		result: v.object({
			verdict,
			phase: v.union(v.literal('sample'), v.literal('hidden')),
			diagnostics: v.optional(v.string()),
			sampleFeedback: v.optional(sampleFeedback),
			sandboxSeconds: v.number(),
			actionSeconds: v.number(),
			metrics: v.optional(
				v.object({ testWallMs: v.array(v.number()), execObservedMs: v.array(v.number()) })
			),
			sampleResults: v.optional(v.array(v.object({ verdict, output: v.string() })))
		})
	},
	handler: (ctx, { attemptId, leaseVersion, result }): Promise<boolean> =>
		runBackend(
			Effect.gen(function* () {
				const a = yield* step(ctx.db.get(attemptId));
				if (!a || a.status !== 'running' || a.leaseVersion !== leaseVersion) {
					yield* step(
						ctx.db.insert('auditLog', {
							at: Date.now(),
							kind: 'stale_result',
							refId: attemptId,
							detail: 'Ignored inactive lease'
						})
					);
					return false;
				}
				// Trusted completion still cannot outrun independent cleanup. Controller
				// callbacks without a sandbox retain their established preflight contract.
				if (
					(a.createStartedAt !== undefined || a.sandboxId) &&
					a.cleanupConfirmedAt === undefined &&
					(a.sandboxObservedAt === undefined || Date.now() < a.sandboxObservedAt + 41000)
				)
					return false;
				if (Date.now() >= a.ceilingAt) {
					yield* expireAttempt(ctx, a, 'RESULT_AFTER_CEILING');
					return false;
				}
				if (result.verdict === 'IE')
					return yield* reject('BAD_INPUT', 'Use _fail for infrastructure classification');
				if (
					!Number.isFinite(result.sandboxSeconds) ||
					result.sandboxSeconds < 0 ||
					result.sandboxSeconds > 60 ||
					!Number.isFinite(result.actionSeconds) ||
					result.actionSeconds < 0 ||
					result.actionSeconds > 600
				)
					return yield* reject('BAD_INPUT');
				if (
					result.metrics &&
					// Up to three public samples followed by fifty hidden tests.
					(result.metrics.testWallMs.length > 53 ||
						result.metrics.testWallMs.length !== result.metrics.execObservedMs.length ||
						[...result.metrics.testWallMs, ...result.metrics.execObservedMs].some(
							(ms) => !Number.isFinite(ms) || ms < 0 || ms > 60000
						))
				)
					return yield* reject('BAD_INPUT');
				const bounded = (s: string, n: number) =>
					new TextDecoder().decode(new TextEncoder().encode(s).slice(0, n));
				const diagnostics =
					result.verdict === 'CE' && result.diagnostics
						? bounded(result.diagnostics.replace(/\/(?:[^\s:/]+\/)+/g, '<sys>/'), 16384)
						: undefined;
				const feedback =
					result.phase === 'sample' && result.sampleFeedback
						? {
								input: bounded(result.sampleFeedback.input, 4096),
								expected: bounded(result.sampleFeedback.expected, 4096),
								actual: bounded(result.sampleFeedback.actual, 4096)
							}
						: undefined;
				yield* release(ctx, a, result.sandboxSeconds, result.actionSeconds);
				yield* step(
					ctx.db.patch(a._id, {
						status: 'done',
						finishedAt: Date.now(),
						sandboxSeconds: result.sandboxSeconds,
						actionSeconds: result.actionSeconds,
						...(result.metrics ? { metrics: result.metrics } : {})
					})
				);
				if (a.submissionId)
					yield* step(
						ctx.db.patch(a.submissionId, {
							phase: result.phase,
							diagnostics,
							sampleFeedback: feedback
						})
					);
				if (a.sampleRunId)
					yield* step(
						ctx.db.patch(a.sampleRunId, {
							diagnostics,
							results: result.sampleResults?.map((r) => ({
								verdict: r.verdict,
								output: bounded(r.output, 4096)
							}))
						})
					);
				yield* finishSubmission(ctx, a, result.verdict);
				if (a.submissionId) {
					const submission = yield* step(ctx.db.get(a.submissionId));
					if (submission) yield* enforceTimingPolicy(ctx, submission.snapshot.problemVersionId);
				}
				yield* step(ctx.scheduler.runAfter(0, internal.judge._pump, {}));
				return true;
			})
		)
});
export const _fail = internalMutation({
	args: {
		...lease,
		failureClass: v.optional(v.union(v.literal('platform'), v.literal('sandbox_lost'))),
		code: v.string(),
		timedOut: v.optional(v.boolean()),
		lowMemory: v.optional(v.boolean())
	},
	handler: (ctx, args) =>
		runBackend(
			Effect.gen(function* () {
				const a = yield* step(ctx.db.get(args.attemptId));
				if (
					!a ||
					!['running', 'dispatched'].includes(a.status) ||
					a.leaseVersion !== args.leaseVersion
				)
					return false;
				yield* failAttempt(ctx, a, args.failureClass ?? 'platform', args.code, args);
				return true;
			})
		)
});
export const _watchdog = internalMutation({
	args: lease,
	handler: (ctx, args) =>
		runBackend(
			Effect.gen(function* () {
				const a = yield* step(ctx.db.get(args.attemptId));
				if (
					!a ||
					!['running', 'dispatched'].includes(a.status) ||
					a.leaseVersion !== args.leaseVersion ||
					Date.now() < a.createdAt + 45000
				)
					return;
				yield* failAttempt(
					ctx,
					a,
					a.contestantStartedAt !== undefined ? 'sandbox_lost' : 'platform',
					'LEASE_EXPIRED',
					{ leaseExpired: true }
				);
			})
		)
});
export const _activeAttempts = internalQuery({
	args: {},
	handler: (ctx) =>
		runBackend(
			Effect.gen(function* () {
				const rows = (yield* Effect.forEach(
					['running', 'dispatched', 'cleaning'] as const,
					(status) =>
						step(
							ctx.db
								.query('judgeAttempts')
								.withIndex('by_status_kind_ceiling', (q) => q.eq('status', status))
								.collect()
						)
				)).flat();
				// The reaper takes the first 100 known cleanup targets; keep oldest first.
				rows.sort((a, b) => a._creationTime - b._creationTime);
				return rows.map((a) => ({
					attemptId: a._id,
					leaseVersion: a.leaseVersion,
					sandboxId: a.sandboxId ?? null,
					status: a.status,
					createStartedAt: a.createStartedAt ?? null,
					sandboxObservedAt: a.sandboxObservedAt ?? null
				}));
			})
		)
});
