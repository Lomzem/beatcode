import type { Page } from '@playwright/test';
import { CARD_RULES, type CardId } from '../../shared/cards';

export const cardNames = {
	'Light mode': 'light_mode',
	'No paste': 'no_paste',
	'No hints': 'no_hints',
	'Brain teaser': 'brain_teaser',
	'Strict compile': 'strict_compile'
} as const;
type CardName = keyof typeof cardNames;
type Ack = 'NONE' | 'PENDING' | 'OK' | 'COOLDOWN' | 'POWER' | 'OTHER';
const prefix = 'CI card failure: ';
const isCard = (value: unknown): value is CardId =>
	typeof value === 'string' && Object.hasOwn(CARD_RULES, value);
const bounded = (n: number, min: number, max: number) =>
	Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : min;

// Observe the genuine member subscription. Private payloads/identity are projected
// immediately; only public enums, booleans and numeric timing remain in state.
export function observeCards(page: Page) {
	let generation = 0,
		connected = false,
		query = false;
	let mutation = false,
		actual: CardId | 'none' | 'other' = 'none',
		ack: Ack = 'NONE';
	let started = Date.now();
	let selectedRequest: number | undefined;
	let selectedQuery: number | undefined;
	const effects = new Map<CardId, { incoming: boolean; seen: boolean; endsAt: number }>();
	// query/incoming describe current selected-subscription evidence. seen/endsAt
	// remain historical across failure, unsubscribe and reconnect; expiry uses the
	// runner's approximate wall clock, not a browser/server clock agreement.
	const invalidate = (queryId?: number) => {
		if (queryId !== undefined && queryId !== selectedQuery) return;
		selectedQuery = undefined;
		query = false;
		for (const state of effects.values()) state.incoming = false;
	};
	page.on('websocket', (socket) => {
		try {
			if (new URL(socket.url()).hostname !== new URL(process.env.PUBLIC_CONVEX_URL!).hostname)
				return;
		} catch {
			return;
		}
		const current = ++generation;
		connected = true;
		invalidate();
		selectedRequest = undefined;
		const queries = new Set<number>();
		socket.on('close', () => {
			if (current === generation) {
				connected = false;
				invalidate();
			}
		});
		socket.on('framesent', ({ payload }) => {
			try {
				const message = JSON.parse(String(payload));
				if (current !== generation || !connected) return;
				if (message.type === 'ModifyQuerySet')
					for (const change of message.modifications ?? []) {
						if (change.type === 'Add' && change.udfPath === 'matches:view')
							queries.add(change.queryId);
						if (change.type === 'Remove') {
							queries.delete(change.queryId);
							invalidate(change.queryId);
						}
					}
				if (message.type === 'Mutation' && message.udfPath === 'cards:play') {
					selectedRequest = typeof message.requestId === 'number' ? message.requestId : undefined;
					mutation = true;
					ack = 'PENDING';
					actual = isCard(message.args?.[0]?.cardId) ? message.args[0].cardId : 'other';
				}
			} catch {
				/* No frame or exception is retained. */
			}
		});
		socket.on('framereceived', ({ payload }) => {
			try {
				const message = JSON.parse(String(payload));
				if (current !== generation || !connected) return;
				if (
					message.type === 'MutationResponse' &&
					selectedRequest !== undefined &&
					selectedRequest === message.requestId
				) {
					selectedRequest = undefined;
					ack =
						message.success === true
							? 'OK'
							: message.errorData?.code === 'COOLDOWN'
								? 'COOLDOWN'
								: message.errorData?.code === 'POWER'
									? 'POWER'
									: 'OTHER';
				}
				if (message.type !== 'Transition') return;
				for (const change of message.modifications ?? []) {
					if (!queries.has(change.queryId)) continue;
					if (change.type === 'QueryFailed' || change.type === 'QueryRemoved') {
						invalidate(change.queryId);
						if (change.type === 'QueryRemoved') queries.delete(change.queryId);
						continue;
					}
					if (change.type !== 'QueryUpdated') continue;
					const value = change.value as {
						playerId?: unknown;
						effects?: { cardId: unknown; targetId: unknown; endsAt: unknown }[];
					};
					if (typeof value?.playerId !== 'string' || !Array.isArray(value.effects)) {
						invalidate(change.queryId);
						continue;
					}
					selectedQuery = change.queryId;
					query = true;
					for (const state of effects.values()) state.incoming = false;
					for (const effect of value.effects)
						if (
							isCard(effect.cardId) &&
							effect.targetId === value.playerId &&
							typeof effect.endsAt === 'number' &&
							Number.isFinite(effect.endsAt)
						)
							effects.set(effect.cardId, { incoming: true, seen: true, endsAt: effect.endsAt });
				}
			} catch {
				/* Only fixed field projections survive the callback. */
			}
		});
	});
	return {
		begin() {
			selectedRequest = undefined;
			mutation = false;
			actual = 'none';
			ack = 'NONE';
			started = Date.now();
		},
		read(name: CardName) {
			const effect = effects.get(cardNames[name]);
			return {
				mutation,
				actual,
				ack,
				connected,
				query,
				incoming: effect?.incoming ?? false,
				seen: effect?.seen ?? false,
				remainingMs: effect ? bounded(effect.endsAt - Date.now(), -3600000, 3600000) : 0,
				elapsedMs: bounded(Date.now() - started, 0, 3600000)
			};
		}
	};
}
type Observation = ReturnType<ReturnType<typeof observeCards>['read']>;
export function cardFailureLine(
	name: CardName,
	direction: 'host-to-guest' | 'guest-to-host',
	source: Observation,
	receiver: Observation,
	count: number,
	visible: boolean
) {
	return (
		prefix +
		JSON.stringify({
			card: cardNames[name],
			direction,
			mutation: source.mutation,
			actual: source.actual,
			ack: source.ack,
			sourceSocket: source.connected,
			receiverSocket: receiver.connected,
			query: receiver.query,
			incoming: receiver.incoming,
			seen: receiver.seen,
			remainingMs: receiver.remainingMs,
			count: bounded(count, -1, 999),
			visible,
			elapsedMs: source.elapsedMs
		})
	);
}

// The stdout owner re-parses and selects exact keys/types. Never forward raw
// prefixed text/JSON, unknown fields, vendor errors or arbitrary identifiers.
export function safeCardFailure(line: string): string | undefined {
	if (!line.startsWith(prefix)) return;
	try {
		const row: unknown = JSON.parse(line.slice(prefix.length));
		if (!row || typeof row !== 'object' || Array.isArray(row)) return;
		const r = row as Record<string, unknown>;
		const booleans = [
			'mutation',
			'sourceSocket',
			'receiverSocket',
			'query',
			'incoming',
			'seen',
			'visible'
		];
		const keys = [
			'card',
			'direction',
			'actual',
			'ack',
			'remainingMs',
			'count',
			'elapsedMs',
			...booleans
		];
		if (Object.keys(r).length !== keys.length || Object.keys(r).some((key) => !keys.includes(key)))
			return;
		if (
			!isCard(r.card) ||
			typeof r.direction !== 'string' ||
			!['host-to-guest', 'guest-to-host'].includes(r.direction) ||
			!(isCard(r.actual) || r.actual === 'none' || r.actual === 'other') ||
			typeof r.ack !== 'string' ||
			!['NONE', 'PENDING', 'OK', 'COOLDOWN', 'POWER', 'OTHER'].includes(r.ack) ||
			booleans.some((key) => typeof r[key] !== 'boolean')
		)
			return;
		const integer = (value: unknown, min: number, max: number) =>
			typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
		if (
			!integer(r.remainingMs, -3600000, 3600000) ||
			!integer(r.count, -1, 999) ||
			!integer(r.elapsedMs, 0, 3600000)
		)
			return;
		return (
			prefix +
			JSON.stringify({
				card: r.card,
				direction: r.direction,
				mutation: r.mutation,
				actual: r.actual,
				ack: r.ack,
				sourceSocket: r.sourceSocket,
				receiverSocket: r.receiverSocket,
				query: r.query,
				incoming: r.incoming,
				seen: r.seen,
				remainingMs: r.remainingMs,
				count: r.count,
				visible: r.visible,
				elapsedMs: r.elapsedMs
			})
		);
	} catch {
		return;
	}
}
