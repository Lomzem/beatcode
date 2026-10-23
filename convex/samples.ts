import type { Id } from './_generated/dataModel';
import { Effect } from 'effect';
import { runBackend, step, reject, syncStep } from './game/effect';
import { admissionSnapshot, sha256 } from './game/binding';
import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { internal } from './_generated/api';
import { roundMember } from './game/rounds';
import { activeRound, idempotencyKey, roundPlayer } from './game/state';
import { daily, settings } from './game/usage';
export const run = mutation({
	args: { roundId: v.id('rounds'), source: v.string(), clientRunId: v.string() },
	handler: (ctx, args): Promise<{ sampleRunId: Id<'sampleRuns'> }> =>
		runBackend(
			Effect.gen(function* () {
				const { round, match, player } = yield* roundMember(ctx, args.roundId);
				yield* syncStep(() => idempotencyKey(args.clientRunId));
				const prior = yield* step(
					ctx.db
						.query('sampleRuns')
						.withIndex('by_player_client', (q) =>
							q.eq('playerId', player._id).eq('clientRunId', args.clientRunId)
						)
						.unique()
				);
				if (prior) {
					if (
						prior.roundId !== round._id ||
						prior.snapshot.sourceSha256 !== (yield* sha256(args.source))
					)
						return yield* reject('BAD_INPUT');
					return { sampleRunId: prior._id };
				}
				yield* syncStep(() => activeRound(round, match));
				const size = new TextEncoder().encode(args.source).length;
				if (size < 1 || size > 65536) return yield* reject('BAD_INPUT');
				const state = yield* roundPlayer(ctx, round._id, player._id);
				// Indexed player-wide reads serialize concurrent admissions across every round.
				const pending = yield* step(
					ctx.db
						.query('sampleRuns')
						.withIndex('by_player_status', (q) =>
							q.eq('playerId', player._id).eq('status', 'pending')
						)
						.first()
				);
				if (pending) return yield* reject('BAD_STATE');
				const latest = yield* step(
					ctx.db
						.query('sampleRuns')
						.withIndex('by_player_created', (q) => q.eq('playerId', player._id))
						.order('desc')
						.first()
				);
				if (latest && Date.now() - latest.createdAt < 5000) return yield* reject('COOLDOWN');
				const ops = yield* settings(ctx);
				if (!ops.judgingEnabled) return yield* reject('PAUSED');
				const usage = yield* daily(ctx);
				const dayStart = Date.parse(usage.day + 'T00:00:00Z');
				const ownToday = yield* step(
					ctx.db
						.query('sampleRuns')
						.withIndex('by_player_created', (q) =>
							q.eq('playerId', player._id).gte('createdAt', dayStart)
						)
						.collect()
				);
				if (state.sampleCount >= 40 || ownToday.length >= 150) return yield* reject('QUOTA');
				const problem = yield* step(ctx.db.get(round.problemVersionId));
				if (!problem) return yield* reject('BAD_STATE');
				const environment = yield* step(ctx.db.get(problem.judgeEnvId));
				if (!environment) return yield* reject('BAD_STATE');
				const sampleRunId = yield* step(
					ctx.db.insert('sampleRuns', {
						roundId: round._id,
						playerId: player._id,
						source: args.source,
						createdAt: Date.now(),
						status: 'pending',
						clientRunId: args.clientRunId,
						snapshot: yield* admissionSnapshot('std', args.source, problem, environment)
					})
				);
				yield* step(
					ctx.db.patch(state._id, {
						lastSampleAt: Date.now(),
						outstandingSampleRunId: sampleRunId,
						sampleCount: state.sampleCount + 1
					})
				);
				yield* step(ctx.db.patch(usage._id, { samples: usage.samples + 1 }));
				yield* step(
					ctx.db.insert('judgeAttempts', {
						kind: 'sample',
						sampleRunId,
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
					ctx.scheduler.runAt(Date.now() + 90000, internal.samples._ceiling, { sampleRunId })
				);
				return { sampleRunId };
			})
		)
});
import { internalMutation } from './_generated/server';
import { expireAttempt } from './game/judging';
export const _ceiling = internalMutation({
	args: { sampleRunId: v.id('sampleRuns') },
	handler: (ctx, { sampleRunId }) =>
		runBackend(
			Effect.gen(function* () {
				const sample = yield* step(ctx.db.get(sampleRunId));
				if (!sample || sample.status !== 'pending') return;
				const a = yield* step(
					ctx.db
						.query('judgeAttempts')
						.withIndex('by_sample', (q) => q.eq('sampleRunId', sampleRunId))
						.first()
				);
				if (a && Date.now() >= a.ceilingAt) yield* expireAttempt(ctx, a, 'SAMPLE_CEILING');
			})
		)
});
