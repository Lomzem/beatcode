import { Data, Effect } from 'effect';
import type { Clerk } from '@clerk/clerk-js';
import * as env from '$app/env/public';

export const auth = $state<{
	clerk: Clerk | null;
	session: Clerk['session'];
	loading: boolean;
	error: string;
}>({ clerk: null, session: null, loading: !!env.PUBLIC_CLERK_PUBLISHABLE_KEY, error: '' });
export const authConfigured = !!env.PUBLIC_CLERK_PUBLISHABLE_KEY;
export const convexUrl = env.PUBLIC_CONVEX_URL ?? '';
class AuthConnectionError extends Data.TaggedError('AuthConnectionError')<{
	readonly message: string;
}> {}

export function loadAuth(): Promise<(() => void) | undefined> {
	return Effect.runPromise(
		Effect.gen(function* () {
			if (!authConfigured) return;
			// Authentication and challenges run on Clerk Account Portal. This official
			// browser export handles only session restoration, JWTs and hosted redirects.
			const { Clerk } = yield* Effect.tryPromise({
				try: () => import('@clerk/clerk-js/no-rhc'),
				catch: () => new AuthConnectionError({ message: 'SDK unavailable' })
			});
			const clerk = yield* Effect.try({
				try: () => new Clerk(env.PUBLIC_CLERK_PUBLISHABLE_KEY!),
				catch: () => new AuthConnectionError({ message: 'SDK configuration unavailable' })
			});
			yield* Effect.tryPromise({
				try: () => {
					// Override this instance's previous custom /sign-in URL. Account Portal
					// uses <instance>.accounts.dev in development and accounts.<domain>
					// in production, where the deployment provisions the Clerk CNAMEs.
					const frontend = clerk.frontendApi;
					const portalHost = frontend.endsWith('.clerk.accounts.dev')
						? frontend.replace('.clerk.accounts.dev', '.accounts.dev')
						: frontend.startsWith('clerk.')
							? `accounts.${frontend.slice('clerk.'.length)}`
							: null;
					if (!portalHost) throw new Error('Unsupported account domain');
					return clerk.load({
						signInUrl: `https://${portalHost}/sign-in`,
						signUpUrl: `https://${portalHost}/sign-up`
					});
				},
				catch: () => new AuthConnectionError({ message: 'Session unavailable' })
			});
			auth.clerk = clerk;
			return yield* Effect.try({
				try: () =>
					clerk.addListener(() => {
						auth.clerk = clerk;
						auth.session = clerk.session;
					}),
				catch: () => new AuthConnectionError({ message: 'Session subscription unavailable' })
			});
		}).pipe(
			Effect.catchTag('AuthConnectionError', () =>
				Effect.sync(() => {
					auth.error = 'Sign-in could not connect. Check your connection and reload to try again.';
					return undefined;
				})
			),
			Effect.ensuring(
				Effect.sync(() => {
					auth.loading = false;
				})
			)
		)
	);
}
