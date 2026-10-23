import { Effect } from 'effect';
import { optionalStorage } from './storage.js';

// Return paths may contain an invite fragment; never send it to a server or external origin.
export function safeReturnPath(raw: string | null): string | null {
	if (!raw || !raw.startsWith('/') || raw.startsWith('//') || /[\\\r\n]/.test(raw)) return null;
	try {
		const url = new URL(raw, location.origin);
		return url.origin === location.origin && ['/join', '/play'].includes(url.pathname)
			? url.pathname + url.search + url.hash
			: null;
	} catch {
		return null;
	}
}
export function rememberReturnPath(raw: string | null) {
	const next = safeReturnPath(raw);
	if (next)
		Effect.runSync(
			optionalStorage(() => sessionStorage.setItem('beatcode.return', next), undefined)
		);
	return next;
}
export function savedReturnPath() {
	return Effect.runSync(
		optionalStorage(() => safeReturnPath(sessionStorage.getItem('beatcode.return')), null)
	);
}
export function clearReturnPath() {
	Effect.runSync(optionalStorage(() => sessionStorage.removeItem('beatcode.return'), undefined));
}
