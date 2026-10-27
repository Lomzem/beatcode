import type { BackendFailure } from './effect';
import { Effect } from 'effect';
import { step } from './effect';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { settle } from './rounds';
import { daily, monthly, settings } from './usage';
import { roundPlayer } from './state';
export function release(
	ctx: MutationCtx,
	attempt: Doc<'judgeAttempts'>,
	sandboxSeconds = 0,
	actionSeconds = 0
): Effect.Effect<void, BackendFailure> {
	return Effect.gen(function* () {
		if (
			!['dispatched', 'running', 'cleaning'].includes(attempt.status) ||
			attempt.reservedSeconds === 0
		)
			return;
		const ops = yield* settings(ctx);
		yield* step(ctx.db.patch(ops._id, { inFlight: Math.max(0, ops.inFlight - 1) }));
		if (attempt.reservationDay && attempt.reservationMonth) {
			const d = yield* daily(ctx, attempt.reservationDay),
				m = yield* monthly(ctx, attempt.reservationMonth);
			yield* step(
				ctx.db.patch(d._id, {
					reservedSeconds: Math.max(0, d.reservedSeconds - attempt.reservedSeconds),
					actualSeconds: d.actualSeconds + sandboxSeconds,
					actionSeconds: d.actionSeconds + actionSeconds
				})
			);
			yield* step(
				ctx.db.patch(m._id, {
					reservedSeconds: Math.max(0, m.reservedSeconds - attempt.reservedSeconds),
					actualSeconds: m.actualSeconds + sandboxSeconds,
					actionSeconds: m.actionSeconds + actionSeconds
				})
			);
		}
	});
}
export function finishSubmission(
	ctx: MutationCtx,
	attempt: Doc<'judgeAttempts'>,
	verdict: 'AC' | 'CE' | 'WA' | 'TLE' | 'MLE' | 'RE' | 'OLE' | 'IE',
	sandboxTerminated = false
): Effect.Effect<void, BackendFailure> {
	return Effect.gen(function* () {
		if (attempt.kind === 'scored' && attempt.submissionId) {
			const s = yield* step(ctx.db.get(attempt.submissionId));
			if (!s || s.status !== 'pending') return;
			yield* step(
				ctx.db.patch(s._id, {
					status: verdict === 'IE' ? 'judge_failed' : 'done',
					verdict,
					decidedAt: Date.now(),
					sandboxTerminated
				})
			);
			const state = yield* roundPlayer(ctx, s.roundId, s.playerId);
			if (state.outstandingSubmissionId === s._id)
				yield* step(ctx.db.patch(state._id, { outstandingSubmissionId: undefined }));
			yield* settle(ctx, s.roundId);
		} else if (attempt.sampleRunId) {
			const s = yield* step(ctx.db.get(attempt.sampleRunId));
			if (!s || s.status !== 'pending') return;
			yield* step(ctx.db.patch(s._id, { status: verdict === 'IE' ? 'judge_failed' : 'done' }));
			const state = yield* roundPlayer(ctx, s.roundId, s.playerId);
			if (state.outstandingSampleRunId === s._id)
				yield* step(ctx.db.patch(state._id, { outstandingSampleRunId: undefined }));
		}
	});
}
export function failAttempt(
	ctx: MutationCtx,
	attempt: Doc<'judgeAttempts'>,
	failureClass: 'platform' | 'sandbox_lost',
	code: string,
	opts: {
		timedOut?: boolean;
		lowMemory?: boolean;
		forceTerminal?: boolean;
		leaseExpired?: boolean;
	} = {}
): Effect.Effect<void, BackendFailure> {
	return Effect.gen(function* () {
		if (!['queued', 'dispatched', 'running'].includes(attempt.status)) return;
		// Once contestant execution starts, an uncorroborated controller failure is
		// sandbox_lost. Untrusted execution must never manufacture an infrastructure void.
		failureClass =
			attempt.contestantStartedAt !== undefined ||
			(opts.forceTerminal && failureClass === 'sandbox_lost')
				? 'sandbox_lost'
				: 'platform';
		const lossAt = attempt.lossAt ?? Date.now();
		const lossVerdict =
			attempt.stage === 'compile'
				? 'CE'
				: attempt.stage === 'run'
					? opts.timedOut
						? 'TLE'
						: opts.lowMemory
							? 'MLE'
							: 'RE'
					: (attempt.lossVerdict ?? 'CE');
		if (failureClass === 'platform')
			yield* step(
				ctx.db.insert('infraIncidents', {
					at: Date.now(),
					source: 'platform',
					attemptId: attempt._id,
					code: code.slice(0, 80)
				})
			);
		yield* step(
			ctx.db.patch(attempt._id, {
				status: 'cleaning',
				failureClass,
				lossAt,
				cleanupForceTerminal: opts.forceTerminal ?? false,
				cleanupLeaseExpired: opts.leaseExpired ?? false,
				...(failureClass === 'sandbox_lost' ? { lossVerdict } : {})
			})
		);
		const cleaning = (yield* step(ctx.db.get(attempt._id)))!;
		if (attempt.sandboxId)
			yield* step(
				ctx.scheduler.runAfter(0, internal.judgeDispatch._terminate, {
					sandboxId: attempt.sandboxId
				})
			);
		if (!attempt.sandboxId && attempt.createStartedAt !== undefined)
			yield* step(ctx.scheduler.runAfter(1000, internal.judgeController._reap, {}));
		yield* finishCleanup(ctx, cleaning);
	});
}

/** Only a real termination receipt, an observed creation + hard lifetime,
 * or a fenced attempt which never authorized create can release ownership. */
export function finishCleanup(
	ctx: MutationCtx,
	attempt: Doc<'judgeAttempts'>
): Effect.Effect<void, BackendFailure> {
	return Effect.gen(function* () {
		if (attempt.status !== 'cleaning') return;
		if (attempt.cleanupConfirmedAt === undefined) {
			if (attempt.sandboxObservedAt !== undefined) {
				const remaining = attempt.sandboxObservedAt + 41000 - Date.now();
				if (remaining > 0) {
					yield* step(
						ctx.scheduler.runAfter(remaining, internal.judge._checkCleanup, {
							attemptId: attempt._id,
							leaseVersion: attempt.leaseVersion
						})
					);
					return;
				}
			} else if (attempt.createStartedAt !== undefined || attempt.sandboxId) {
				// No invented death deadline for a create with no response. The
				// tagged reaper and late create callback retain and recover ownership.
				return;
			}
		}
		const failureClass = attempt.failureClass === 'sandbox_lost' ? 'sandbox_lost' : 'platform';
		const lossAt = attempt.lossAt ?? Date.now();
		const lossVerdict = attempt.lossVerdict ?? 'CE';
		yield* release(ctx, attempt, attempt.reservedSeconds, 45);
		yield* step(
			ctx.db.patch(attempt._id, {
				status: attempt.cleanupLeaseExpired ? 'lease_expired' : 'ie',
				finishedAt: Date.now()
			})
		);
		const previous = attempt.submissionId
			? yield* step(
					ctx.db
						.query('judgeAttempts')
						.withIndex('by_submission', (q) => q.eq('submissionId', attempt.submissionId))
						.collect()
				)
			: [];
		const firstLoss = Math.min(
			lossAt,
			...previous.filter((a) => a.lossAt !== undefined).map((a) => a.lossAt!)
		);
		if (
			!attempt.cleanupForceTerminal &&
			attempt.kind === 'scored' &&
			attempt.attemptNo === 1 &&
			Date.now() + 45000 <= attempt.ceilingAt
		) {
			yield* step(
				ctx.db.insert('judgeAttempts', {
					kind: 'scored',
					submissionId: attempt.submissionId,
					attemptNo: 2,
					status: 'queued',
					leaseVersion: 0,
					ceilingAt: attempt.ceilingAt,
					reservedSeconds: 0,
					createdAt: Date.now(),
					lossAt: firstLoss,
					...(failureClass === 'sandbox_lost' ? { failureClass, lossVerdict } : {})
				})
			);
		} else {
			const incidents = yield* step(
				ctx.db
					.query('infraIncidents')
					.withIndex('by_at', (q) => q.gte('at', firstLoss - 120000).lte('at', Date.now()))
					.collect()
			);
			// A different submission's isolated preflight failure does not establish
			// an outage for this loss. Keep the retry's own platform evidence and
			// explicit operator declarations as independent corroboration.
			const corroborated = incidents.some(
				(incident) =>
					incident.source === 'operator' ||
					(incident.source === 'platform' && previous.some((a) => a._id === incident.attemptId))
			);
			yield* finishSubmission(
				ctx,
				attempt,
				failureClass === 'platform' || corroborated ? 'IE' : lossVerdict,
				failureClass === 'sandbox_lost'
			);
		}
		yield* step(ctx.scheduler.runAfter(0, internal.judge._pump, {}));
	});
}
export function expireAttempt(
	ctx: MutationCtx,
	attempt: Doc<'judgeAttempts'>,
	code: string
): Effect.Effect<void, BackendFailure> {
	return Effect.gen(function* () {
		const history = attempt.submissionId
			? yield* step(
					ctx.db
						.query('judgeAttempts')
						.withIndex('by_submission', (q) => q.eq('submissionId', attempt.submissionId))
						.collect()
				)
			: [];
		const failureClass =
			attempt.contestantStartedAt !== undefined ||
			history.some((a) => a.failureClass === 'sandbox_lost')
				? 'sandbox_lost'
				: 'platform';
		yield* failAttempt(ctx, attempt, failureClass, code, { forceTerminal: true });
	});
}
