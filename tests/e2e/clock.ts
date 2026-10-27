import { expect, type Page } from '@playwright/test';

// Observe clock pings at the Convex WebSocket boundary. Keep only send times;
// a reconnect resends an in-flight request under its original number.
export function observeClockPings(page: Page) {
	const sent = new Map<number, number>();
	page.on('websocket', (socket) => {
		socket.on('framesent', ({ payload }) => {
			try {
				const message = JSON.parse(String(payload));
				if (
					message.type === 'Mutation' &&
					message.udfPath === 'clock:ping' &&
					!sent.has(message.requestId)
				)
					sent.set(message.requestId, Date.now());
			} catch {
				/* Binary/unrelated vendor traffic is outside this seam. */
			}
		});
	});
	return () => [...sent.values()];
}

export function expectClockNotRestarted(read: ReturnType<typeof observeClockPings>) {
	// A running clock pings every 30 seconds. A closer pair means profile updates
	// restarted it, briefly replacing the server offset with local time.
	const sent = read();
	console.info(`CI clock pings: ${sent.length}`);
	expect(sent.length, 'A profile must start the clock').toBeGreaterThanOrEqual(1);
	for (let index = 1; index < sent.length; index++)
		expect(
			sent[index] - sent[index - 1],
			'Profile query updates must not restart the clock'
		).toBeGreaterThanOrEqual(25000);
}
