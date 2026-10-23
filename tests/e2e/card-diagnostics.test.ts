import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Page } from '@playwright/test';
import { observeCards } from './card-diagnostics';

afterEach(() => vi.unstubAllEnvs());

// Exercise the registered Playwright socket callbacks, not a separate reducer.
// Synthetic vendor messages prove observer bookkeeping, never authentication or
// reproduction of the actual GitHub game failure.
function boundary() {
	vi.stubEnv('PUBLIC_CONVEX_URL', 'https://observer.example');
	const page = new EventEmitter();
	const observer = observeCards(page as unknown as Page);
	const socket = Object.assign(new EventEmitter(), {
		url: () => 'wss://observer.example/api/sync'
	});
	page.emit('websocket', socket);
	const send = (message: unknown) => socket.emit('framesent', { payload: JSON.stringify(message) });
	const receive = (message: unknown) =>
		socket.emit('framereceived', { payload: JSON.stringify(message) });
	const add = (queryId: number) =>
		send({
			type: 'ModifyQuerySet',
			modifications: [{ type: 'Add', queryId, udfPath: 'matches:view' }]
		});
	const update = (queryId: number) =>
		receive({
			type: 'Transition',
			modifications: [
				{
					type: 'QueryUpdated',
					queryId,
					value: {
						playerId: 'synthetic-member',
						effects: [
							{ cardId: 'light_mode', targetId: 'synthetic-member', endsAt: Date.now() + 20000 }
						]
					}
				}
			]
		});
	const play = (requestId: number, cardId: string) =>
		send({ type: 'Mutation', udfPath: 'cards:play', requestId, args: [{ cardId }] });
	return { observer, page, socket, send, receive, add, update, play };
}

it.each(['QueryFailed', 'QueryRemoved', 'unsubscribe', 'close', 'reconnect'])(
	'%s invalidates current receiver evidence while preserving historical observation',
	(kind) => {
		const b = boundary();
		b.add(1);
		b.update(1);
		expect(b.observer.read('Light mode')).toMatchObject({
			query: true,
			incoming: true,
			seen: true
		});
		if (kind === 'unsubscribe')
			b.send({ type: 'ModifyQuerySet', modifications: [{ type: 'Remove', queryId: 1 }] });
		else if (kind === 'close' || kind === 'reconnect') {
			b.socket.emit('close');
			if (kind === 'reconnect') {
				const next = Object.assign(new EventEmitter(), {
					url: () => 'wss://observer.example/api/sync'
				});
				// A replacement socket has no current query yet; history remains history.
				b.page.emit('websocket', next);
			}
		} else b.receive({ type: 'Transition', modifications: [{ type: kind, queryId: 1 }] });
		expect(b.observer.read('Light mode')).toMatchObject({
			query: false,
			incoming: false,
			seen: true
		});
		if (kind === 'QueryFailed') {
			b.update(1);
			expect(b.observer.read('Light mode')).toMatchObject({
				query: true,
				incoming: true,
				seen: true
			});
		} else {
			b.update(1); // An obsolete callback must not resurrect removed/closed evidence.
			expect(b.observer.read('Light mode')).toMatchObject({
				query: false,
				incoming: false,
				seen: true
			});
		}
	}
);

it.each(['QueryFailed', 'QueryRemoved', 'unsubscribe'])(
	'an unrelated %s does not erase the current selected subscription',
	(kind) => {
		const b = boundary();
		b.add(1);
		b.add(2);
		b.update(2);
		if (kind === 'unsubscribe')
			b.send({ type: 'ModifyQuerySet', modifications: [{ type: 'Remove', queryId: 1 }] });
		else b.receive({ type: 'Transition', modifications: [{ type: kind, queryId: 1 }] });
		expect(b.observer.read('Light mode')).toMatchObject({
			query: true,
			incoming: true,
			seen: true
		});
	}
);

it('pairs acknowledgement only with the selected latest card request', () => {
	const b = boundary();
	b.observer.begin();
	b.play(1, 'light_mode');
	b.play(2, 'no_hints');
	b.receive({ type: 'MutationResponse', requestId: 1, success: true });
	expect(b.observer.read('No hints')).toMatchObject({
		mutation: true,
		actual: 'no_hints',
		ack: 'PENDING'
	});
	b.receive({
		type: 'MutationResponse',
		requestId: 2,
		success: false,
		errorData: { code: 'POWER' }
	});
	b.receive({ type: 'MutationResponse', requestId: 1, success: true });
	expect(b.observer.read('No hints')).toMatchObject({
		mutation: true,
		actual: 'no_hints',
		ack: 'POWER'
	});
});
