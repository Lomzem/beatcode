import type { BrowserContext } from '@playwright/test';

const local = 'http://127.0.0.1:4188';

/** Blocks every request and WebSocket outside the fixture server and records the attempts. */
export async function isolate(context: BrowserContext) {
	const outbound: string[] = [];
	await context.route('**/*', (route) => {
		const url = route.request().url();
		if (new URL(url).origin === local) return route.continue();
		outbound.push(url);
		return route.abort();
	});
	// Vite's HMR socket is local; it is closed too because the fixture page never reloads itself.
	await context.routeWebSocket(/.*/, (socket) => {
		if (new URL(socket.url()).host !== new URL(local).host) outbound.push(socket.url());
		socket.close();
	});
	return outbound;
}
