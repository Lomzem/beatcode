<script lang="ts">
	import { Data, Effect } from 'effect';
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { SvelteURL } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { rememberReturnPath, savedReturnPath, clearReturnPath } from '#lib/auth/return-path.js';
	import { auth, authConfigured, convexUrl } from '#lib/auth/client.svelte.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { PUBLIC_CLERK_OAUTH_PROVIDERS } from '$app/env/public';

	let returnPath = $state<string | null>(null);
	let returnSaved = $state(true);
	let manualReturn = $state(false);
	let mounted = $state(false);
	let busy = $state(false);
	let error = $state('');
	const providers = [
		{ id: 'github', label: 'GitHub' },
		{ id: 'discord', label: 'Discord' },
		{ id: 'google', label: 'Google' }
	];
	const enabled = PUBLIC_CLERK_OAUTH_PROVIDERS.split(',').map((provider) => provider.trim());
	const methods = [
		...providers
			.filter((provider) => enabled.includes(provider.id))
			.map((provider) => provider.label),
		'an email code'
	];

	onMount(() => {
		const fragment = new URLSearchParams(page.url.hash.slice(1));
		manualReturn = fragment.get('return') === 'manual';
		if (manualReturn) clearReturnPath();
		else {
			returnPath =
				rememberReturnPath(fragment.get('next') ?? page.url.searchParams.get('next')) ??
				savedReturnPath();
			returnSaved = !returnPath || savedReturnPath() === returnPath;
		}
		mounted = true;
	});
	$effect(() => {
		if (mounted && auth.session && returnPath) {
			// Consume the destination so a later visit to this page stays on the account.
			clearReturnPath();
			void goto(resolve(returnPath as '/join'), { replaceState: true });
		}
	});

	class AuthActionFailure extends Data.TaggedError('AuthActionFailure') {}
	const action = (operation: () => Promise<unknown>) =>
		Effect.tryPromise({ try: operation, catch: () => new AuthActionFailure() });

	function continueToClerk(withoutReturn = false) {
		const clerk = auth.clerk;
		if (!clerk || busy) return;
		// Read back immediately before leaving: storage can become unavailable after mount.
		if (returnPath && !withoutReturn) {
			rememberReturnPath(returnPath);
			returnSaved = savedReturnPath() === returnPath;
			if (!returnSaved) return;
		}
		busy = true;
		error = '';
		// Never let Clerk default redirectUrl to location.href: it can contain an invite.
		const destination = new SvelteURL(resolve('/sign-in'), location.origin);
		if (withoutReturn) destination.hash = 'return=manual';
		const redirectUrl = destination.href;
		return Effect.runPromise(
			action(() =>
				clerk.redirectToSignIn({
					redirectUrl,
					signInForceRedirectUrl: redirectUrl,
					signUpForceRedirectUrl: redirectUrl
				})
			).pipe(
				Effect.catchTag('AuthActionFailure', () =>
					Effect.sync(() => {
						error = 'Sign-in could not open. Check your connection and try again.';
					})
				),
				Effect.ensuring(
					Effect.sync(() => {
						busy = false;
					})
				)
			)
		);
	}
	function signOut() {
		const clerk = auth.clerk;
		if (!clerk || busy) return;
		busy = true;
		error = '';
		return Effect.runPromise(
			action(() => clerk.signOut({ redirectUrl: resolve('/sign-in') })).pipe(
				Effect.tap(() => Effect.sync(clearReturnPath)),
				Effect.catchTag('AuthActionFailure', () =>
					Effect.sync(() => {
						error = 'Sign-out could not connect. Check your connection and try again.';
					})
				),
				Effect.ensuring(
					Effect.sync(() => {
						busy = false;
					})
				)
			)
		);
	}
</script>

<svelte:head><title>Sign in — Beatcode</title></svelte:head>
<div class="shell page auth-page">
	<h1>Sign in</h1>
	<div class="auth-links">
		<a href={resolve('/')}>Back to overview</a>
		<a href={resolve('/privacy')}>Privacy</a>
	</div>
	<section aria-label="Sign-in">
		{#if returnPath?.startsWith('/join#')}
			<p><a href={resolve(returnPath as '/join')}>Return to invitation</a></p>
		{/if}
		{#if !returnSaved}
			<p role="alert">
				Your browser cannot save this invitation for the trip to sign-in. Keep the invitation link,
				then reopen it after signing in.
			</p>
		{/if}
		{#if !authConfigured}
			<h2>Sign-in is unavailable</h2>
			<p role="status">
				Sign-in is not configured on this installation yet. Please try again after setup is
				complete.
			</p>
		{:else if auth.error}
			<h2>Connection unavailable</h2>
			<p role="alert">{auth.error}</p>
			<Button onclick={() => window.location.reload()}>Reload and try again</Button>
		{:else if auth.session}
			<h2>You’re signed in</h2>
			<p role="status">
				{manualReturn
					? 'Reopen your invitation link to join its room.'
					: convexUrl
						? 'Your account is connected. You can create or join private rooms.'
						: 'Your account is connected. The match service is not configured yet.'}
			</p>
			<div class="actions">
				<Button href={resolve('/play')}>Open rooms</Button>
				<Button class="min-w-36" variant="outline" onclick={signOut} disabled={busy || auth.loading}
					>{busy ? 'Signing out…' : 'Sign out'}</Button
				>
			</div>
		{:else}
			<p>
				Use {methods.slice(0, -1).join(', ')}{methods.length > 1 ? ', or ' : ''}{methods.at(-1)}.
			</p>
			<p class="connection-status" role="status">
				{busy ? 'Opening sign-in…' : auth.loading ? 'Connecting…' : ''}
			</p>
			{#if !returnSaved}
				<Button disabled={busy || auth.loading || !mounted} onclick={() => continueToClerk(true)}
					>Continue without automatic return</Button
				>
			{:else}
				<Button disabled={busy || auth.loading || !mounted} onclick={() => continueToClerk()}
					>Continue with Clerk</Button
				>
			{/if}
			<details>
				<summary>Sign-in help</summary>
				<p>
					Clerk handles sign-in and account creation on its own page, then brings you back here. You
					can choose a different method there if you cannot access your account.
				</p>
			</details>
		{/if}
		{#if error}<p class="error" role="alert">{error}</p>{/if}
	</section>
</div>

<style>
	.auth-page {
		display: grid;
		grid-template-columns: 1fr;
		max-width: 34rem;
		align-content: start;
		min-height: 0;
		gap: 0.5rem;
	}
	h1 {
		margin-bottom: 0.25rem;
	}
	h2 {
		font-size: 1.5rem;
	}
	.auth-links,
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}
	.auth-links a {
		display: inline-flex;
		min-height: 44px;
		align-items: center;
	}
	.connection-status {
		min-block-size: 1.6em;
		margin: 0 0 0.5rem;
	}
	details {
		margin-top: 1rem;
	}
	summary {
		min-height: 44px;
		align-content: center;
		cursor: pointer;
	}
</style>
