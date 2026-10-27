import type { BackendFailure } from './effect';
import { Effect } from 'effect';
import { step, reject } from './effect';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { matchMember } from './access';
export function roundMember(
	ctx: MutationCtx | QueryCtx,
	roundId: Id<'rounds'>
): Effect.Effect<
	{
		player: Doc<'players'>;
		match: Doc<'matches'>;
		room: Doc<'rooms'>;
		seat: 'host' | 'guest';
		round: Doc<'rounds'>;
	},
	BackendFailure
> {
	return Effect.gen(function* () {
		const round = yield* step(ctx.db.get(roundId));
		if (!round) return yield* reject('NOT_FOUND');
		return { ...(yield* matchMember(ctx, round.matchId)), round };
	});
}
export function begin(ctx: MutationCtx, round: Doc<'rounds'>): Effect.Effect<void, BackendFailure> {
	return Effect.gen(function* () {
		const match = yield* step(ctx.db.get(round.matchId));
		if (
			!match ||
			match.status !== 'active' ||
			round.status !== 'intermission' ||
			Date.now() < round.startsAt
		)
			return;
		yield* step(ctx.db.patch(round._id, { status: 'active', nextSeq: round.nextSeq + 1 }));
		const problem = yield* step(ctx.db.get(round.problemVersionId));
		for (const playerId of match.playerIds) {
			yield* step(
				ctx.db.insert('roundPlayers', {
					roundId: round._id,
					playerId,
					power: 3,
					powerTick: 0,
					usedCards: [],
					scoredCount: 0,
					sampleCount: 0
				})
			);
			if (problem)
				yield* step(
					ctx.db.insert('playerProblemExposure', {
						playerId,
						problemId: problem.problemId,
						at: Date.now()
					})
				);
		}
		yield* step(
			ctx.scheduler.runAt(round.endsAt, internal.rounds._deadline, { roundId: round._id })
		);
	});
}
export function createRound(
	ctx: MutationCtx,
	match: Doc<'matches'>,
	slot: number,
	version: Id<'problemVersions'>,
	delay: number
): Effect.Effect<Id<'rounds'>, BackendFailure> {
	return Effect.gen(function* () {
		const startsAt = Date.now() + delay;
		const roundId = yield* step(
			ctx.db.insert('rounds', {
				matchId: match._id,
				index: match.roundIndex + 1,
				slot,
				problemVersionId: version,
				status: 'intermission',
				startsAt,
				endsAt: startsAt + 600000,
				nextSeq: 0,
				readyNext: { a: false, b: false }
			})
		);
		yield* step(ctx.db.patch(match._id, { roundIndex: match.roundIndex + 1 }));
		if (delay === 0) yield* begin(ctx, (yield* step(ctx.db.get(roundId)))!);
		else {
			const beginScheduledId = yield* step(
				ctx.scheduler.runAt(startsAt, internal.rounds._begin, {
					roundId
				})
			);
			yield* step(ctx.db.patch(roundId, { beginScheduledId }));
		}
		return roundId;
	});
}
export function finishMatch(
	ctx: MutationCtx,
	match: Doc<'matches'>,
	result: 'win' | 'draw' | 'aborted',
	reason: string,
	winnerId?: Id<'players'>
): Effect.Effect<void, BackendFailure> {
	return Effect.gen(function* () {
		const unfinished = yield* step(
			ctx.db
				.query('rounds')
				.withIndex('by_match_index', (q) => q.eq('matchId', match._id))
				.collect()
		);
		for (const r of unfinished)
			if (r.status !== 'finished')
				yield* step(
					ctx.db.patch(r._id, {
						status: 'finished',
						decidedAt: Date.now(),
						nextSeq: r.nextSeq + 1
					})
				);
		yield* step(
			ctx.db.patch(match._id, {
				status: 'finished',
				result,
				reason,
				winnerId,
				endedAt: Date.now()
			})
		);
		yield* step(
			ctx.db.patch(match.roomId, {
				status: 'results',
				ready: { host: false, guest: false },
				rematch: { host: false, guest: false }
			})
		);
	});
}
export function finishRound(
	ctx: MutationCtx,
	round: Doc<'rounds'>,
	outcome: 'won' | 'drawn' | 'void',
	winnerId?: Id<'players'>,
	winningSubmissionId?: Id<'submissions'>
): Effect.Effect<void, BackendFailure> {
	return Effect.gen(function* () {
		if (round.status === 'finished') return;
		const match = yield* step(ctx.db.get(round.matchId));
		if (!match || match.status !== 'active') return;
		yield* step(
			ctx.db.patch(round._id, {
				status: 'finished',
				outcome,
				winnerId,
				winningSubmissionId,
				decidedAt: Date.now(),
				nextSeq: round.nextSeq + 1
			})
		);
		const wins = { ...match.wins };
		if (winnerId) wins[match.playerIds[0] === winnerId ? 'a' : 'b']++;
		const voidCount = match.voidCount + (outcome === 'void' ? 1 : 0);
		yield* step(ctx.db.patch(match._id, { wins, voidCount }));
		const updated = { ...match, wins, voidCount };
		if (voidCount >= 2) return yield* finishMatch(ctx, updated, 'aborted', 'void_limit');
		const completed = round.index - voidCount;
		if (wins.a >= 2 || wins.b >= 2 || completed >= 3) {
			const winner = wins.a === wins.b ? undefined : match.playerIds[wins.a > wins.b ? 0 : 1];
			return yield* finishMatch(ctx, updated, winner ? 'win' : 'draw', 'rounds', winner);
		}
		const slot = outcome === 'void' ? round.slot : round.slot + 1;
		const version =
			outcome === 'void' ? match.spareProblems[slot - 1] : match.problemPlan[slot - 1];
		if (!version) return yield* finishMatch(ctx, updated, 'aborted', 'void_limit');
		yield* createRound(ctx, updated, slot, version, 20000);
	});
}
export function settle(
	ctx: MutationCtx,
	roundId: Id<'rounds'>
): Effect.Effect<void, BackendFailure> {
	return Effect.gen(function* () {
		const round = yield* step(ctx.db.get(roundId));
		if (!round || round.status === 'finished' || round.status === 'intermission') return;
		const submissions = yield* step(
			ctx.db
				.query('submissions')
				.withIndex('by_round_seq', (q) => q.eq('roundId', roundId))
				.collect()
		);
		const accepted = submissions.find((s) => s.verdict === 'AC');
		const relevant = accepted ? submissions.filter((s) => s.seq < accepted.seq) : submissions;
		if (accepted || Date.now() >= round.endsAt) {
			if (relevant.some((s) => s.status === 'judge_failed'))
				return yield* finishRound(ctx, round, 'void');
			if (relevant.some((s) => s.status === 'pending')) {
				if (round.status !== 'settling')
					yield* step(ctx.db.patch(roundId, { status: 'settling', nextSeq: round.nextSeq + 1 }));
				return;
			}
			return accepted
				? yield* finishRound(ctx, round, 'won', accepted.playerId, accepted._id)
				: yield* finishRound(ctx, round, 'drawn');
		}
	});
}
