import { Effect } from 'effect';
import { runBackend, step, reject } from './game/effect';
import { activeCatalog } from './game/catalog';
import { v } from 'convex/values';
import { internalMutation, query } from './_generated/server';
import { matchMember } from './game/access';
import { createRound } from './game/rounds';
import { isActiveEffect } from './game/state';
import { roundView } from './game/views';
export const _start = internalMutation({
	args: { roomId: v.id('rooms') },
	handler: (ctx, { roomId }) =>
		runBackend(
			Effect.gen(function* () {
				const room = yield* step(ctx.db.get(roomId));
				if (
					!room ||
					room.status !== 'lobby' ||
					!room.guestId ||
					!room.ready.host ||
					!room.ready.guest
				)
					return;
				const ids = [room.hostId, room.guestId];
				for (const id of ids) {
					const p = yield* step(ctx.db.get(id));
					if (!p || p.disabled) return;
				}
				const decks = yield* Effect.forEach(ids, (playerId) =>
					step(
						ctx.db
							.query('decks')
							.withIndex('by_room_player', (q) => q.eq('roomId', roomId).eq('playerId', playerId))
							.unique()
					)
				);
				if (decks.some((d) => !d || d.cardIds.length !== 4)) return;
				const exposure = (yield* Effect.forEach(ids, (playerId) =>
					step(
						ctx.db
							.query('playerProblemExposure')
							.withIndex('by_player', (q) => q.eq('playerId', playerId))
							.collect()
					)
				))
					.flat()
					.filter((e) => e.at > Date.now() - 30 * 86400000);
				const seen = new Set(exposure.map((e) => e.problemId));
				const active = (yield* activeCatalog(ctx)).map((p) => ({ ...p, random: Math.random() }));
				active.sort(
					(a, b) =>
						a.difficulty - b.difficulty ||
						Number(seen.has(a._id)) - Number(seen.has(b._id)) ||
						a.random - b.random
				);
				const plan = [],
					spare = [];
				for (const difficulty of [1, 2, 3]) {
					const pool = active.filter((p) => p.difficulty === difficulty);
					if (pool.length < 2)
						return yield* reject('BAD_STATE', 'Active calibrated problem pool is incomplete');
					plan.push(pool[0].versionId);
					spare.push(pool[1].versionId);
				}
				const matchId = yield* step(
					ctx.db.insert('matches', {
						roomId,
						playerIds: ids,
						status: 'active',
						wins: { a: 0, b: 0 },
						roundIndex: 0,
						voidCount: 0,
						problemPlan: plan,
						spareProblems: spare,
						startedAt: Date.now(),
						sharedSource: { a: false, b: false }
					})
				);
				for (const d of decks) yield* step(ctx.db.patch(d!._id, { lockedForMatchId: matchId }));
				yield* step(
					ctx.db.patch(roomId, {
						status: 'in_match',
						currentMatchId: matchId,
						startScheduledId: undefined
					})
				);
				yield* createRound(ctx, (yield* step(ctx.db.get(matchId)))!, 1, plan[0], 0);
			})
		)
});
export const view = query({
	args: { matchId: v.id('matches') },
	handler: (ctx, { matchId }) =>
		runBackend(
			Effect.gen(function* () {
				const { match, player } = yield* matchMember(ctx, matchId);
				const rounds = yield* step(
					ctx.db
						.query('rounds')
						.withIndex('by_match_index', (q) => q.eq('matchId', matchId))
						.collect()
				);
				const round = rounds.at(-1)!;
				const version = yield* step(ctx.db.get(round.problemVersionId));
				const problem = version ? yield* step(ctx.db.get(version.problemId)) : null;
				const players = yield* Effect.forEach(match.playerIds, (playerId) =>
					Effect.gen(function* () {
						const p = yield* step(ctx.db.get(playerId));
						const state = yield* step(
							ctx.db
								.query('roundPlayers')
								.withIndex('by_round_player', (q) =>
									q.eq('roundId', round._id).eq('playerId', playerId)
								)
								.unique()
						);
						return {
							playerId,
							displayName: p!.displayName,
							power: state
								? Math.min(
										10,
										state.power +
											Math.max(
												0,
												Math.floor((Date.now() - round.startsAt) / 10000) - state.powerTick
											)
									)
								: 3,
							powerTick: state?.powerTick ?? 0,
							usedCards: state?.usedCards ?? []
						};
					})
				);
				const effects =
					round.status === 'active'
						? (yield* Effect.forEach(match.playerIds, (id) =>
								step(
									ctx.db
										.query('effects')
										.withIndex('by_round_target', (q) =>
											q.eq('roundId', round._id).eq('targetId', id)
										)
										.collect()
								)
							))
								.flat()
								.filter((e) => isActiveEffect(e, Date.now()))
								.map((e) => ({
									effectId: e._id,
									cardId: e.cardId,
									sourceId: e.sourceId,
									targetId: e.targetId,
									startsAt: e.startsAt,
									endsAt: e.endsAt,
									...(e.challenge && e.targetId === player._id
										? { challenge: { a: e.challenge.a, b: e.challenge.b } }
										: {})
								}))
						: [];
				const history = yield* Effect.forEach(rounds, (r) => roundView(ctx, r, match, player._id));
				const current = history.at(-1)!;
				const { ownSubmissions, ownSampleRuns, opponentPending, opponentVerdicts } = current;
				return {
					matchId,
					roomId: match.roomId,
					playerId: player._id,
					status: match.status,
					wins: match.wins,
					result: match.result ?? null,
					winnerId: match.winnerId ?? null,
					reason: match.reason ?? null,
					round: current,
					rounds: history,
					players,
					effects,
					ownSubmissions,
					ownSampleRuns,
					opponentPending,
					opponentVerdicts,
					problem:
						version && problem
							? {
									title: problem.title,
									statementMd: version.statementMd,
									samples: version.samples,
									limits: version.limits
								}
							: null
				};
			})
		)
});
import { mutation } from './_generated/server';
import { finishMatch } from './game/rounds';
export const concede = mutation({
	args: { matchId: v.id('matches') },
	handler: (ctx, { matchId }) =>
		runBackend(
			Effect.gen(function* () {
				const { match, player } = yield* matchMember(ctx, matchId);
				if (match.status !== 'active') return yield* reject('BAD_STATE');
				yield* finishMatch(
					ctx,
					match,
					'win',
					'concede',
					match.playerIds.find((id) => id !== player._id)
				);
			})
		)
});
export const claimForfeit = mutation({
	args: { matchId: v.id('matches') },
	handler: (ctx, { matchId }) =>
		runBackend(
			Effect.gen(function* () {
				const { match, room, seat, player } = yield* matchMember(ctx, matchId);
				if (
					match.status !== 'active' ||
					room.currentMatchId !== matchId ||
					room.status !== 'in_match'
				)
					return yield* reject('BAD_STATE');
				const ownSeen = room.lastSeen[seat] ?? 0,
					otherSeen = room.lastSeen[seat === 'host' ? 'guest' : 'host'] ?? 0;
				if (Date.now() - ownSeen > 120000 || Date.now() - otherSeen <= 120000)
					return yield* reject('BAD_STATE');
				yield* finishMatch(ctx, match, 'win', 'forfeit', player._id);
			})
		)
});
export const shareSource = mutation({
	args: { matchId: v.id('matches') },
	handler: (ctx, { matchId }) =>
		runBackend(
			Effect.gen(function* () {
				const { match, player } = yield* matchMember(ctx, matchId);
				if (match.status !== 'finished') return yield* reject('BAD_STATE');
				yield* step(
					ctx.db.patch(matchId, {
						sharedSource: {
							...match.sharedSource,
							[match.playerIds[0] === player._id ? 'a' : 'b']: true
						}
					})
				);
			})
		)
});
