// Stand-in for @clerk/clerk-js/no-rhc in the auth-return build only. The hosted
// Account Portal is replaced by an immediate return to the requested redirect URL.
const sessionKey = 'auth-return-fixture.session';
type Listener = () => void;

export class Clerk {
	readonly frontendApi = 'clerk.auth-return.test';
	session: { getToken: () => Promise<null> } | null = null;
	#listeners = new Set<Listener>();
	constructor(readonly publishableKey: string) {}
	async load() {
		this.session = localStorage.getItem(sessionKey) ? { getToken: async () => null } : null;
	}
	addListener(listener: Listener) {
		this.#listeners.add(listener);
		listener();
		return () => this.#listeners.delete(listener);
	}
	async redirectToSignIn(options: { redirectUrl: string }) {
		localStorage.setItem(sessionKey, '1');
		// Record what the hosted page would receive; it must not carry the destination.
		localStorage.setItem('auth-return-fixture.redirect', JSON.stringify(options));
		const target = new URL(options.redirectUrl);
		const fragmentOnly = target.hash && target.href.split('#')[0] === location.href.split('#')[0];
		location.assign(target);
		// Returning from the hosted page is a full load, even when only the fragment differs.
		if (fragmentOnly) location.reload();
	}
	async signOut() {
		localStorage.removeItem(sessionKey);
		this.session = null;
		for (const listener of this.#listeners) listener();
	}
}
