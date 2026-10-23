import type { Page } from '@playwright/test';

// Follow the genuine member subscription used by Match. The UI immediately
// advances to the next round after AC; history retains the authoritative profile
// and verdict even when the current-round submissions panel becomes empty.
export function observeScoredResult(page: Page) {
	let strictAC = false;
	page.on('websocket', (socket) => {
		const queries = new Set<number>();
		socket.on('framesent', ({ payload }) => {
			try {
				const message = JSON.parse(String(payload));
				if (message.type !== 'ModifyQuerySet') return;
				for (const change of message.modifications ?? []) {
					if (change.type === 'Add' && change.udfPath === 'matches:view')
						queries.add(change.queryId);
					if (change.type === 'Remove') queries.delete(change.queryId);
				}
			} catch {
				/* No frame or private identity is retained. */
			}
		});
		socket.on('framereceived', ({ payload }) => {
			try {
				const message = JSON.parse(String(payload));
				if (message.type !== 'Transition') return;
				for (const change of message.modifications ?? []) {
					if (change.type !== 'QueryUpdated' || !queries.has(change.queryId)) continue;
					for (const round of change.value?.rounds ?? [])
						for (const submission of round.ownSubmissions ?? [])
							if (submission.profile === 'strict' && submission.verdict === 'AC') strictAC = true;
				}
			} catch {
				/* Only the verified result boolean leaves the callback. */
			}
		});
	});
	return () => strictAC;
}
