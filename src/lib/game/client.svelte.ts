import { untrack } from 'svelte';
import { CARD_RULES } from '../../../shared/cards';
import { useAuth, useConvexClient, useQuery } from 'convex-svelte';
import type { FunctionReference, FunctionArgs, FunctionReturnType } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import { Data, Effect, Schedule } from 'effect';
import { ConvexError } from 'convex/values';
import { createServerClock } from './clock';
export { api };
export type Room = FunctionReturnType<typeof api.rooms.view>;
export type Match = FunctionReturnType<typeof api.matches.view>;
export type CardId = FunctionArgs<typeof api.cards.play>['cardId'];
const messages: Record<string, string> = {
	AUTH_INVALID: 'Your match session is not verified. Sign in again or reload.',
	NO_PLAYER: 'Choose a nickname first.',
	NOT_FOUND:
		'This room or invitation is unavailable. It may be expired, used, or full. Ask the host for a new invitation.',
	BAD_STATE: 'This action is no longer available. Check the current room or round state.',
	BAD_INPUT: 'Check your entry and try again.',
	QUOTA: 'The usage limit has been reached. Try again later.',
	POWER: 'You need more power for that card.',
	CHARGE: 'That card has already been used this round.',
	COOLDOWN: 'Wait a moment before trying again.',
	STACK: 'That effect is already active on your opponent.',
	CHALLENGE: 'Answer the brain teaser before submitting. You can still run samples.',
	PAUSED: 'Judging is paused. Your source is saved; try again when judging resumes.',
	DISABLED: 'This account or action is disabled. A host pass is required to create rooms.'
};
export function explain(cause: unknown) {
	const data = cause instanceof ConvexError ? cause.data : null;
	const code = typeof data === 'object' && data && 'code' in data ? String(data.code) : '';
	return (
		messages[code] ??
		'Could not connect to the match service. Check your connection and try again. Your local draft is preserved.'
	);
}
class MatchServiceError extends Data.TaggedError('MatchServiceError')<{
	readonly message: string;
}> {}

export function createGameClient() {
	const session = useAuth();
	const client = useConvexClient();
	const me = useQuery(api.players.me, () => (session.isAuthenticated ? {} : 'skip'));
	const state = $state({
		pending: '',
		error: '',
		message: '',
		connected: client.connectionState().isWebSocketConnected,
		serverNow: Date.now(),
		clockReady: false
	});
	function mutate<M extends FunctionReference<'mutation'>>(
		label: string,
		mutation: M,
		args: FunctionArgs<M>
	): Effect.Effect<FunctionReturnType<M> | undefined> {
		return Effect.suspend(() => {
			if (state.pending || !session.isAuthenticated || !state.connected)
				return Effect.succeed(undefined);
			state.pending = label;
			state.error = '';
			state.message = '';
			return Effect.tryPromise({
				try: () => client.mutation(mutation, args),
				catch: (cause) => new MatchServiceError({ message: explain(cause) })
			}).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						state.message = label + ' complete.';
					})
				),
				Effect.catchTag('MatchServiceError', (cause) =>
					Effect.sync(() => {
						state.error = cause.message;
						return undefined;
					})
				),
				Effect.ensuring(
					Effect.sync(() => {
						state.pending = '';
					})
				)
			);
		});
	}
	function run<M extends FunctionReference<'mutation'>>(
		label: string,
		mutation: M,
		args: FunctionArgs<M>
	) {
		return Effect.runPromise(mutate(label, mutation, args));
	}
	function navigate(operation: () => Promise<void>) {
		return Effect.tryPromise({
			try: operation,
			catch: () =>
				new MatchServiceError({ message: 'Could not open the next page. Reload to try again.' })
		}).pipe(
			Effect.catchTag('MatchServiceError', (cause) =>
				Effect.sync(() => {
					state.error = cause.message;
				})
			)
		);
	}

	$effect(() => {
		return Effect.runCallback(
			Effect.scoped(
				Effect.gen(function* () {
					yield* Effect.acquireRelease(
						Effect.sync(() =>
							client.subscribeToConnectionState((connection) => {
								state.connected = connection.isWebSocketConnected;
							})
						),
						(unsubscribe) => Effect.sync(unsubscribe)
					);
					yield* Effect.never;
				})
			)
		);
	});
	$effect(() => {
		if (!session.isAuthenticated || !me.data) return;
		const clock = createServerClock();
		const sync = Effect.gen(function* () {
			const before = Date.now();
			const result = yield* Effect.tryPromise({
				try: () => client.mutation(api.clock.ping, {}),
				catch: () => new MatchServiceError({ message: 'Clock unavailable' })
			});
			const receivedAt = Date.now();
			clock.observePing(before, result.serverNow, receivedAt);
			state.serverNow = clock.now(receivedAt);
			state.clockReady = true;
		}).pipe(Effect.catchTag('MatchServiceError', () => Effect.void));
		return Effect.runCallback(
			Effect.scoped(
				Effect.gen(function* () {
					yield* Effect.forkScoped(sync.pipe(Effect.repeat(Schedule.spaced('30 seconds'))));
					yield* Effect.sync(() => {
						state.serverNow = clock.now(Date.now());
					}).pipe(Effect.repeat(Schedule.spaced('1 second')));
				})
			)
		);
	});
	return { session, me, state, client, mutate, run, navigate };
}
export type GameClient = ReturnType<typeof createGameClient>;
export const gameKey = Symbol('game');
export const cardCatalog: {
	id: CardId;
	name: string;
	cost: number;
	description: string;
	enforcement: string;
}[] = [
	{
		id: 'light_mode',
		name: 'Light mode',
		cost: CARD_RULES.light_mode.cost,
		description:
			'Light palette for 20 seconds. High contrast and increased system contrast are exempt.',
		enforcement: 'Editor honor effect'
	},
	{
		id: 'no_paste',
		name: 'No paste',
		cost: CARD_RULES.no_paste.cost,
		description:
			'Blocks paste and drop into the editor for 20 seconds. Typing, copy and navigation remain available.',
		enforcement: 'Editor honor effect'
	},
	{
		id: 'no_hints',
		name: 'No hints',
		cost: CARD_RULES.no_hints.cost,
		description: 'Turns off suggestions, bracket closing and automatic indentation for 20 seconds.',
		enforcement: 'Editor honor effect'
	},
	{
		id: 'brain_teaser',
		name: 'Brain teaser',
		cost: CARD_RULES.brain_teaser.cost,
		description:
			'An arithmetic challenge blocks scored submissions for up to 15 seconds. Samples remain available.',
		enforcement: 'Server enforced'
	},
	{
		id: 'strict_compile',
		name: 'Strict compile',
		cost: CARD_RULES.strict_compile.cost,
		description: 'Next scored submission within 30 seconds uses ISO C++20 with -pedantic-errors.',
		enforcement: 'Server enforced'
	}
];
export function timeLeft(endsAt: number, now: number) {
	const seconds = Math.max(0, Math.ceil((endsAt - now) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function keepPresence(
	game: GameClient,
	roomId: () => FunctionArgs<typeof api.presence.heartbeat>['roomId'] | undefined
) {
	// Query objects change after each heartbeat; primitive identity and auth
	// alone own this fiber's lifetime, including initially asynchronous loading.
	const currentRoomId = $derived(roomId());
	const authenticated = $derived(game.session.isAuthenticated);
	$effect(() => {
		const id = currentRoomId;
		if (!id || !authenticated) return;
		const heartbeat = Effect.suspend(() =>
			game.state.connected
				? Effect.tryPromise({
						try: () => game.client.mutation(api.presence.heartbeat, { roomId: id }),
						catch: () => new MatchServiceError({ message: 'Presence unavailable' })
					}).pipe(Effect.catchTag('MatchServiceError', () => Effect.void))
				: Effect.void
		);
		return untrack(() =>
			Effect.runCallback(
				Effect.scoped(heartbeat.pipe(Effect.repeat(Schedule.spaced('20 seconds'))))
			)
		);
	});
}
