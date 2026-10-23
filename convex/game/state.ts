import type { BackendFailure } from './effect';
import { Effect } from 'effect';
import { reject, step } from './effect';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { fail } from './access';
export function isActiveEffect(e: Doc<'effects'>, now: number) {
	return e.startsAt <= now && now < e.endsAt && !e.consumedBySubmissionId && !e.challenge?.solvedAt;
}
export function effectsOn(
	ctx: MutationCtx | QueryCtx,
	roundId: Id<'rounds'>,
	playerId: Id<'players'>
): Effect.Effect<Doc<'effects'>[], BackendFailure> {
	return Effect.gen(function* () {
		return (yield* step(
			ctx.db
				.query('effects')
				.withIndex('by_round_target', (q) => q.eq('roundId', roundId).eq('targetId', playerId))
				.collect()
		)).filter((e) => isActiveEffect(e, Date.now()));
	});
}
export function activeRound(round: Doc<'rounds'>, match: Doc<'matches'>) {
	if (match.status !== 'active' || round.status !== 'active' || Date.now() >= round.endsAt)
		fail('BAD_STATE');
}
export function idempotencyKey(key: string) {
	if (!key.length || key.length > 128 || /[\p{Cc}\p{Cs}]/u.test(key)) fail('BAD_INPUT');
}
export function roundPlayer(
	ctx: MutationCtx | QueryCtx,
	roundId: Id<'rounds'>,
	playerId: Id<'players'>
): Effect.Effect<Doc<'roundPlayers'>, BackendFailure> {
	return Effect.gen(function* () {
		const state = yield* step(
			ctx.db
				.query('roundPlayers')
				.withIndex('by_round_player', (q) => q.eq('roundId', roundId).eq('playerId', playerId))
				.unique()
		);
		if (!state) return yield* reject('BAD_STATE');
		return state;
	});
}
export function refreshPower(state: Doc<'roundPlayers'>, round: Doc<'rounds'>) {
	const powerTick = Math.max(0, Math.floor((Date.now() - round.startsAt) / 10000));
	return { powerTick, power: Math.min(10, state.power + powerTick - state.powerTick) };
}
