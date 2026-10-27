import { Effect } from 'effect';
import { runBackend, step, reject, syncStep } from './game/effect';
import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { roundMember } from './game/rounds';
import {
	activeRound,
	effectsOn,
	idempotencyKey,
	isActiveEffect,
	refreshPower,
	roundPlayer
} from './game/state';
import { CARDS } from './game/cards';
import { cardId } from './game/validators';
export const play = mutation({
	args: { roundId: v.id('rounds'), cardId, clientPlayId: v.string() },
	handler: (ctx, args) =>
		runBackend(
			Effect.gen(function* () {
				const { round, match, player } = yield* roundMember(ctx, args.roundId);
				yield* syncStep(() => idempotencyKey(args.clientPlayId));
				const previous = yield* step(
					ctx.db
						.query('effects')
						.withIndex('by_round_source_client', (q) =>
							q
								.eq('roundId', round._id)
								.eq('sourceId', player._id)
								.eq('clientPlayId', args.clientPlayId)
						)
						.unique()
				);
				if (previous) {
					if (previous.cardId !== args.cardId) return yield* reject('BAD_INPUT');
					return { seq: previous.seq, endsAt: previous.endsAt };
				}
				yield* syncStep(() => activeRound(round, match));
				const deck = yield* step(
					ctx.db
						.query('decks')
						.withIndex('by_room_player', (q) =>
							q.eq('roomId', match.roomId).eq('playerId', player._id)
						)
						.unique()
				);
				if (!deck || deck.lockedForMatchId !== match._id || !deck.cardIds.includes(args.cardId))
					return yield* reject('BAD_INPUT');
				const state = yield* roundPlayer(ctx, round._id, player._id);
				if (state.usedCards.includes(args.cardId)) return yield* reject('CHARGE');
				if (state.lastPlayAt !== undefined && Date.now() - state.lastPlayAt < 2000)
					return yield* reject('COOLDOWN');
				const refreshed = refreshPower(state, round),
					card = CARDS[args.cardId];
				if (refreshed.power < card.cost) return yield* reject('POWER');
				const targetId = match.playerIds.find((id) => id !== player._id)!;
				if ((yield* effectsOn(ctx, round._id, targetId)).some((e) => e.cardId === args.cardId))
					return yield* reject('STACK');
				const seq = round.nextSeq,
					endsAt = Date.now() + card.duration;
				yield* step(ctx.db.patch(round._id, { nextSeq: seq + 1 }));
				yield* step(
					ctx.db.patch(state._id, {
						...refreshed,
						power: refreshed.power - card.cost,
						usedCards: [...state.usedCards, args.cardId],
						lastPlayAt: Date.now()
					})
				);
				yield* step(
					ctx.db.insert('effects', {
						roundId: round._id,
						seq,
						sourceId: player._id,
						targetId,
						cardId: args.cardId,
						startsAt: Date.now(),
						endsAt,
						clientPlayId: args.clientPlayId,
						...(args.cardId === 'brain_teaser'
							? {
									challenge: {
										a: 10 + Math.floor(Math.random() * 90),
										b: 10 + Math.floor(Math.random() * 90)
									}
								}
							: {})
					})
				);
				return { seq, endsAt };
			})
		)
});
export const answerChallenge = mutation({
	args: { roundId: v.id('rounds'), effectId: v.id('effects'), answer: v.number() },
	handler: (ctx, args) =>
		runBackend(
			Effect.gen(function* () {
				const { round, match, player } = yield* roundMember(ctx, args.roundId);
				const e = yield* step(ctx.db.get(args.effectId));
				if (!e || e.roundId !== round._id || e.targetId !== player._id)
					return yield* reject('NOT_FOUND');
				yield* syncStep(() => activeRound(round, match));
				if (!e.challenge || !isActiveEffect(e, Date.now())) return yield* reject('BAD_STATE');
				if (!Number.isSafeInteger(args.answer)) return yield* reject('BAD_INPUT');
				const solved = args.answer === e.challenge.a + e.challenge.b;
				if (
					!solved &&
					e.challenge.lastAnswerAt !== undefined &&
					Date.now() - e.challenge.lastAnswerAt < 1000
				)
					return yield* reject('COOLDOWN');
				yield* step(
					ctx.db.patch(e._id, {
						challenge: {
							...e.challenge,
							lastAnswerAt: Date.now(),
							...(solved ? { solvedAt: Date.now() } : {})
						}
					})
				);
				yield* step(ctx.db.patch(round._id, { nextSeq: round.nextSeq + 1 }));
				return { solved };
			})
		)
});
