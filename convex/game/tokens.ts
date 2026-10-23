import type { BackendFailure } from './effect';
import { Effect } from 'effect';
import { step } from './effect';
export function secretToken() {
	const bytes = Uint8Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
}
export function hashToken(token: string): Effect.Effect<string, BackendFailure> {
	return Effect.gen(function* () {
		const bytes = yield* step(crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
		return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
	});
}
