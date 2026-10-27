import type { Id } from './_generated/dataModel';
import { Effect } from 'effect';
import { runBackend, step, reject, syncStep } from './game/effect';
import { admissionSnapshot, sha256 } from './game/binding';
import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { internal } from './_generated/api';
import { roundMember } from './game/rounds';
import { activeRound, effectsOn, idempotencyKey, roundPlayer } from './game/state';
import { daily, settings } from './game/usage';
export const submit = mutation({
	args: { roundId: v.id('rounds'), source: v.string(), clientSubmitId: v.string() },
	handler: (ctx, args): Promise<{ submissionId: Id<'submissions'>; seq: number }> =>
		runBackend(
			Effect.gen(function* () {
				const { round, match, player } = yield* roundMember(ctx, args.roundId);
				yield* syncStep(() => idempotencyKey(args.clientSubmitId));
				const prior = yield* step(
					ctx.db
						.query('submissions')
						.withIndex('by_player_client', (q) =>
							q.eq('playerId', player._id).eq('clientSubmitId', args.clientSubmitId)
						)
						.unique()
				);
				if (prior) {
					if (
						prior.roundId !== round._id ||
						prior.snapshot.sourceSha256 !== (yield* sha256(args.source))
					)
						return yield* reject('BAD_INPUT');
					return { submissionId: prior._id, seq: prior.seq };
				}
				yield* syncStep(() => activeRound(round, match));
				const sourceBytes = new TextEncoder().encode(args.source).length;
				if (sourceBytes < 1 || sourceBytes > 65536) return yield* reject('BAD_INPUT');
				const state = yield* roundPlayer(ctx, round._id, player._id);
				// Indexed player-wide reads serialize concurrent admissions across every round.
				const pending = yield* step(
					ctx.db
						.query('submissions')
						.withIndex('by_player_status', (q) =>
							q.eq('playerId', player._id).eq('status', 'pending')
						)
						.first()
				);
				if (pending) return yield* reject('BAD_STATE');
				const latest = yield* step(
					ctx.db
						.query('submissions')
						.withIndex('by_player_received', (q) => q.eq('playerId', player._id))
						.order('desc')
						.first()
				);
				if (latest && Date.now() - latest.receivedAt < 3000) return yield* reject('COOLDOWN');
				const effects = yield* effectsOn(ctx, round._id, player._id);
				if (effects.some((e) => e.cardId === 'brain_teaser')) return yield* reject('CHALLENGE');
				const ops = yield* settings(ctx);
				if (!ops.judgingEnabled) return yield* reject('PAUSED');
				const usage = yield* daily(ctx);
				const dayStart = Date.parse(usage.day + 'T00:00:00Z');
				const ownToday = yield* step(
					ctx.db
						.query('submissions')
						.withIndex('by_player_received', (q) =>
							q.eq('playerId', player._id).gte('receivedAt', dayStart)
						)
						.collect()
				);
				if (state.scoredCount >= 30 || ownToday.length >= 80 || usage.scored >= 400)
					return yield* reject('QUOTA');
				const problem = yield* step(ctx.db.get(round.problemVersionId));
				if (!problem) return yield* reject('BAD_STATE');
				const environment = yield* step(ctx.db.get(problem.judgeEnvId));
				if (!environment) return yield* reject('BAD_STATE');
				const strict = effects.find((e) => e.cardId === 'strict_compile');
				const submissionId = yield* step(
					ctx.db.insert('submissions', {
						roundId: round._id,
						matchId: match._id,
						playerId: player._id,
						seq: round.nextSeq,
						receivedAt: Date.now(),
						ceilingAt: Date.now() + 90000,
						source: args.source,
						sourceBytes,
						snapshot: yield* admissionSnapshot(
							strict ? 'strict' : 'std',
							args.source,
							problem,
							environment
						),
						clientSubmitId: args.clientSubmitId,
						status: 'pending'
					})
				);
				if (strict) yield* step(ctx.db.patch(strict._id, { consumedBySubmissionId: submissionId }));
				yield* step(ctx.db.patch(round._id, { nextSeq: round.nextSeq + 1 }));
				yield* step(
					ctx.db.patch(state._id, {
						lastSubmitAt: Date.now(),
						outstandingSubmissionId: submissionId,
						scoredCount: state.scoredCount + 1
					})
				);
				yield* step(ctx.db.patch(usage._id, { scored: usage.scored + 1 }));
				yield* step(
					ctx.db.insert('judgeAttempts', {
						kind: 'scored',
						submissionId,
						attemptNo: 1,
						status: 'queued',
						leaseVersion: 0,
						ceilingAt: Date.now() + 90000,
						reservedSeconds: 0,
						createdAt: Date.now()
					})
				);
				yield* step(ctx.scheduler.runAfter(0, internal.judge._pump, {}));
				yield* step(
					ctx.scheduler.runAt(Date.now() + 90000, internal.rounds._ceiling, { submissionId })
				);
				return { submissionId, seq: round.nextSeq };
			})
		)
});
