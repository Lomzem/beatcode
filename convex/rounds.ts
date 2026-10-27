import { Effect } from 'effect';
import { runBackend, step, reject } from './game/effect';
import { v } from 'convex/values';
import { internalMutation, mutation } from './_generated/server';
import { internal } from './_generated/api';
import { begin, roundMember, settle } from './game/rounds';
export const _begin = internalMutation({
	args: { roundId: v.id('rounds') },
	handler: (ctx, { roundId }) =>
		runBackend(
			Effect.gen(function* () {
				const r = yield* step(ctx.db.get(roundId));
				if (r) yield* begin(ctx, r);
			})
		)
});
export const _deadline = internalMutation({
	args: { roundId: v.id('rounds') },
	handler: (ctx, { roundId }) =>
		runBackend(
			Effect.gen(function* () {
				const r = yield* step(ctx.db.get(roundId));
				if (r && Date.now() >= r.endsAt) yield* settle(ctx, roundId);
			})
		)
});
export const readyNext = mutation({
	args: { roundId: v.id('rounds') },
	handler: (ctx, { roundId }): Promise<void> =>
		runBackend(
			Effect.gen(function* () {
				const { round, match, player } = yield* roundMember(ctx, roundId);
				if (round.status !== 'intermission' || match.status !== 'active')
					return yield* reject('BAD_STATE');
				const readyNext = {
					...round.readyNext,
					[match.playerIds[0] === player._id ? 'a' : 'b']: true
				};
				if (readyNext.a && readyNext.b && round.startsAt > Date.now() + 3000) {
					if (round.beginScheduledId) yield* step(ctx.scheduler.cancel(round.beginScheduledId));
					const startsAt = Date.now() + 3000;
					const beginScheduledId = yield* step(
						ctx.scheduler.runAt(startsAt, internal.rounds._begin, {
							roundId
						})
					);
					yield* step(
						ctx.db.patch(roundId, {
							readyNext,
							startsAt,
							endsAt: startsAt + 600000,
							beginScheduledId,
							nextSeq: round.nextSeq + 1
						})
					);
				} else yield* step(ctx.db.patch(roundId, { readyNext, nextSeq: round.nextSeq + 1 }));
			})
		)
});
import { expireAttempt } from './game/judging';
export const _ceiling = internalMutation({
	args: { submissionId: v.id('submissions') },
	handler: (ctx, { submissionId }) =>
		runBackend(
			Effect.gen(function* () {
				const s = yield* step(ctx.db.get(submissionId));
				if (!s || s.status !== 'pending' || Date.now() < s.ceilingAt) return;
				const attempts = yield* step(
					ctx.db
						.query('judgeAttempts')
						.withIndex('by_submission', (q) => q.eq('submissionId', submissionId))
						.collect()
				);
				const latest = attempts.sort((a, b) => b.attemptNo - a.attemptNo)[0];
				if (latest) yield* expireAttempt(ctx, latest, 'SETTLEMENT_CEILING');
			})
		)
});
