import { expect, type Page } from '@playwright/test';

// Observe the installed Convex WebSocket protocol at the browser boundary. Keep
// only counts/request numbers; never retain frames, identities, JWTs or room IDs.
export function observePresence(page: Page) {
	let emitted = 0,
		accepted = 0,
		failed = 0;
	page.on('websocket', (socket) => {
		const pending = new Set<number>();
		socket.on('framesent', ({ payload }) => {
			try {
				const message = JSON.parse(String(payload));
				if (message.type === 'Mutation' && message.udfPath === 'presence:heartbeat') {
					emitted++;
					pending.add(message.requestId);
				}
			} catch {
				/* Binary/unrelated vendor traffic is outside this seam. */
			}
		});
		socket.on('framereceived', ({ payload }) => {
			try {
				const message = JSON.parse(String(payload));
				if (message.type === 'MutationResponse' && pending.delete(message.requestId)) {
					if (message.success) accepted++;
					else failed++;
				}
			} catch {
				/* No payload leaves the callback. */
			}
		});
	});
	return () => ({ emitted, accepted, failed });
}

export async function expectPresenceCadence(page: Page, read: ReturnType<typeof observePresence>) {
	// The room query starts undefined and loads asynchronously. Require initial
	// AND recurring server-accepted presence, allowing scheduling/network slack.
	// Check the upper bound throughout so a burst fails in the first second.
	for (let second = 0; second < 23; second++) {
		await page.waitForTimeout(1000);
		const counts = read();
		console.info(
			`CI presence: ${counts.emitted} emitted ${counts.accepted} accepted ${counts.failed} failed`
		);
		expect(counts.emitted, 'Presence must not restart on room query updates').toBeLessThanOrEqual(
			3
		);
		expect(counts.failed, 'Presence mutations must be acknowledged').toBe(0);
	}
	expect(
		read().accepted,
		'Loaded room must start presence and retain its recurring owner'
	).toBeGreaterThanOrEqual(2);
}

export async function expectPresenceStopped(page: Page, read: ReturnType<typeof observePresence>) {
	// A deliberate full reload may destroy the previous socket before a response
	// event is delivered. Cancellation is proved by subsequent emitted requests,
	// independent of lifetime response accounting across destroyed documents.
	const before = read().emitted;
	for (let second = 0; second < 23; second++) {
		await page.waitForTimeout(1000);
		expect(
			read().emitted - before,
			'Former presence owner must stop on room/auth/unmount changes'
		).toBe(0);
	}
	console.info(`CI presence stopped: ${read().emitted - before}`);
}
