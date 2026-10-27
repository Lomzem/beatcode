import { Effect } from 'effect';
import { step } from './effect';
import type { Id, TableNames } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { expireAttempt } from './judging';
const DAY = 86400000;
const PAGE_SIZE = 50;
// A daily sweep uses an immutable cutoff and resumes after every bounded page.
export function purgePage(ctx: MutationCtx, phase: number, cursor: string | null, at: number) {
	return Effect.gen(function* () {
		const pagination = { numItems: PAGE_SIZE, cursor };
		const cutoff = at - 7 * DAY;
		if (phase === 0) {
			const page = yield* step(
				ctx.db
					.query('submissions')
					.withIndex('by_creation_time', (q) => q.lt('_creationTime', cutoff))
					.paginate(pagination)
			);
			for (const s of page.page)
				if (s.purgedAt === undefined)
					yield* step(
						ctx.db.patch(s._id, {
							source: undefined,
							diagnostics: undefined,
							sampleFeedback: undefined,
							purgedAt: at
						})
					);
			return page;
		}
		if (phase === 1) {
			const page = yield* step(
				ctx.db
					.query('sampleRuns')
					.withIndex('by_creation_time', (q) => q.lt('_creationTime', cutoff))
					.paginate(pagination)
			);
			for (const s of page.page)
				if (s.purgedAt === undefined)
					yield* step(
						ctx.db.patch(s._id, {
							source: undefined,
							diagnostics: undefined,
							results: undefined,
							purgedAt: at
						})
					);
			return page;
		}
		if (phase === 2) {
			const page = yield* step(
				ctx.db
					.query('judgeAttempts')
					.withIndex('by_creation_time', (q) => q.lt('_creationTime', cutoff))
					.paginate(pagination)
			);
			for (const a of page.page)
				if (a.purgedAt === undefined)
					yield* step(ctx.db.patch(a._id, { metrics: undefined, purgedAt: at }));
			return page;
		}
		const operationalCutoff = at - 30 * DAY;
		function expiredMatch(matchId: Id<'matches'>) {
			return Effect.gen(function* () {
				const match = yield* step(ctx.db.get(matchId));
				return (
					!match ||
					(match.status === 'finished' &&
						match.endedAt !== undefined &&
						match.endedAt < operationalCutoff)
				);
			});
		}
		function expiredRound(roundId: Id<'rounds'>) {
			return Effect.gen(function* () {
				const round = yield* step(ctx.db.get(roundId));
				return !round || (yield* expiredMatch(round.matchId));
			});
		}
		function scan<T extends TableNames>(table: T) {
			return Effect.gen(function* () {
				const page = yield* step(
					ctx.db.query(table).withIndex('by_creation_time').order('asc').paginate(pagination)
				);
				return {
					...page,
					isDone: page.isDone || page.page.some((doc) => doc._creationTime >= operationalCutoff),
					page: page.page.filter((doc) => doc._creationTime < operationalCutoff)
				};
			});
		}
		// Remove the expired public root first. Child pages then reclaim its records
		// without ever leaving a readable match with partially deleted round history.
		if (phase === 3) {
			const page = yield* scan('matches');
			for (const match of page.page)
				if (yield* expiredMatch(match._id)) {
					const room = yield* step(ctx.db.get(match.roomId));
					if (room?.currentMatchId === match._id)
						yield* step(ctx.db.patch(room._id, { currentMatchId: undefined }));
					yield* step(ctx.db.delete(match._id));
				}
			return page;
		}
		if (phase === 4) {
			const page = yield* scan('judgeAttempts');
			for (const a of page.page) {
				if (a.status === 'queued' || a.status === 'dispatched' || a.status === 'running')
					yield* expireAttempt(ctx, a, 'RETENTION_CEILING');
				// Cleanup owns capacity until its receipt; never delete that ownership.
				const current = yield* step(ctx.db.get(a._id));
				if (current?.status === 'cleaning') continue;
				const s = a.submissionId
					? yield* step(ctx.db.get(a.submissionId))
					: a.sampleRunId
						? yield* step(ctx.db.get(a.sampleRunId))
						: null;
				if (!s || (yield* expiredRound(s.roundId))) yield* step(ctx.db.delete(a._id));
			}
			return page;
		}
		if (phase === 5) {
			const page = yield* scan('sampleRuns');
			for (const s of page.page)
				if (yield* expiredRound(s.roundId)) yield* step(ctx.db.delete(s._id));
			return page;
		}
		if (phase === 6) {
			const page = yield* scan('submissions');
			for (const s of page.page)
				if (yield* expiredMatch(s.matchId)) yield* step(ctx.db.delete(s._id));
			return page;
		}
		if (phase === 7) {
			const page = yield* scan('effects');
			for (const e of page.page)
				if (yield* expiredRound(e.roundId)) yield* step(ctx.db.delete(e._id));
			return page;
		}
		if (phase === 8) {
			const page = yield* scan('roundPlayers');
			for (const p of page.page)
				if (yield* expiredRound(p.roundId)) yield* step(ctx.db.delete(p._id));
			return page;
		}
		if (phase === 9) {
			const page = yield* scan('rounds');
			for (const r of page.page)
				if (yield* expiredMatch(r.matchId)) yield* step(ctx.db.delete(r._id));
			return page;
		}
		if (phase === 10) {
			const page = yield* scan('infraIncidents');
			for (const i of page.page) if (i.at < operationalCutoff) yield* step(ctx.db.delete(i._id));
			return page;
		}
		if (phase === 11) {
			const page = yield* scan('auditLog');
			for (const log of page.page)
				if (log.at < operationalCutoff) yield* step(ctx.db.delete(log._id));
			return page;
		}
		const page = yield* scan('playerProblemExposure');
		for (const e of page.page) if (e.at < operationalCutoff) yield* step(ctx.db.delete(e._id));
		return page;
	});
}
