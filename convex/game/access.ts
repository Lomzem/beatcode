import type { UserIdentity } from 'convex/server';
import type { Doc } from '../_generated/dataModel';
import type { BackendFailure } from './effect';
import { Effect } from 'effect';
import { reject, step } from './effect';
import { ConvexError } from 'convex/values';
import type { MutationCtx, QueryCtx } from '../_generated/server';
export function fail(code: string, message = code): never {
	throw new ConvexError({ code, message });
}
export function identity(ctx: QueryCtx | MutationCtx): Effect.Effect<UserIdentity, BackendFailure> {
	return Effect.gen(function* () {
		const user = yield* step(ctx.auth.getUserIdentity());
		if (!user) return yield* reject('AUTH_INVALID');
		return user;
	});
}
export function requirePlayer(
	ctx: QueryCtx | MutationCtx
): Effect.Effect<Doc<'players'>, BackendFailure> {
	return Effect.gen(function* () {
		const user = yield* identity(ctx);
		const player = yield* step(
			ctx.db
				.query('players')
				.withIndex('by_token', (q) => q.eq('tokenIdentifier', user.tokenIdentifier))
				.unique()
		);
		if (!player) return yield* reject('NO_PLAYER');
		if (player.disabled) return yield* reject('DISABLED');
		return player;
	});
}
export function displayName(raw: string) {
	if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(raw)) fail('BAD_INPUT');
	const name = raw.normalize('NFC').trim();
	if ([...name].length < 2 || [...name].length > 24) fail('BAD_INPUT');
	return name;
}
import type { Id } from '../_generated/dataModel';
export function member(
	ctx: QueryCtx | MutationCtx,
	roomId: Id<'rooms'>
): Effect.Effect<
	{ player: Doc<'players'>; room: Doc<'rooms'>; seat: 'host' | 'guest' },
	BackendFailure
> {
	return Effect.gen(function* () {
		const player = yield* requirePlayer(ctx);
		const room = yield* step(ctx.db.get(roomId));
		if (!room || (room.hostId !== player._id && room.guestId !== player._id))
			return yield* reject('NOT_FOUND');
		return {
			player,
			room,
			seat: room.hostId === player._id ? ('host' as const) : ('guest' as const)
		};
	});
}

// Historical authority belongs to the immutable participants, even after a seat changes.
export function matchMember(
	ctx: QueryCtx | MutationCtx,
	matchId: Id<'matches'>
): Effect.Effect<
	{ player: Doc<'players'>; match: Doc<'matches'>; room: Doc<'rooms'>; seat: 'host' | 'guest' },
	BackendFailure
> {
	return Effect.gen(function* () {
		const player = yield* requirePlayer(ctx);
		const match = yield* step(ctx.db.get(matchId));
		if (!match || !match.playerIds.includes(player._id)) return yield* reject('NOT_FOUND');
		const room = yield* step(ctx.db.get(match.roomId));
		if (!room) return yield* reject('NOT_FOUND');
		return {
			player,
			match,
			room,
			seat: match.playerIds[0] === player._id ? ('host' as const) : ('guest' as const)
		};
	});
}
