import { Effect } from 'effect';
import { step, reject } from './effect';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
export function timingReport(ctx: MutationCtx | QueryCtx, problemVersionId: Id<'problemVersions'>) {
	return Effect.gen(function* () {
		const version = yield* step(ctx.db.get(problemVersionId));
		if (!version) return yield* reject('NOT_FOUND');
		const verdicts = yield* step(
			ctx.db
				.query('submissions')
				.withIndex('by_problem_status_decided', (q) =>
					q.eq('snapshot.problemVersionId', problemVersionId).eq('status', 'done')
				)
				.order('desc')
				.take(20)
		);
		const measurements = [];
		for (const s of verdicts) {
			// A submission has at most two attempts; successful completion owns metrics.
			const attempts = yield* step(
				ctx.db
					.query('judgeAttempts')
					.withIndex('by_submission', (q) => q.eq('submissionId', s._id))
					.take(2)
			);
			const metrics = attempts.find((a) => a.status === 'done')?.metrics;
			if (metrics?.testWallMs.length) {
				const slowestTestMs = Math.max(...metrics.testWallMs);
				measurements.push({
					submissionId: s._id,
					slowestTestMs,
					nearThreshold:
						slowestTestMs >= version.limits.timeMs / 1.5 &&
						slowestTestMs <= version.limits.timeMs * 1.5
				});
			}
		}
		return {
			problemVersionId,
			status: version.status,
			timeMs: version.limits.timeMs,
			scored: verdicts.length,
			measured: measurements.length,
			nearThreshold: measurements.filter((m) => m.nearThreshold).length,
			measurements
		};
	});
}
export function enforceTimingPolicy(ctx: MutationCtx, problemVersionId: Id<'problemVersions'>) {
	return Effect.gen(function* () {
		const report = yield* timingReport(ctx, problemVersionId);
		if (
			report.status === 'active' &&
			report.scored >= 20 &&
			report.nearThreshold / report.scored > 0.05
		) {
			yield* step(ctx.db.patch(problemVersionId, { status: 'calibrating' }));
			yield* step(
				ctx.db.insert('auditLog', {
					at: Date.now(),
					kind: 'timing_recalibration',
					refId: problemVersionId,
					detail: 'Over 5% of last 20 scored verdicts near threshold'
				})
			);
		}
	});
}
