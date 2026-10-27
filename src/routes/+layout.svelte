<script lang="ts">
	import { resolve } from '$app/paths';
	import '../app.css';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { setupConvex, setupAuth } from 'convex-svelte';
	import { auth, convexUrl, loadAuth } from '#lib/auth/client.svelte.js';
	let { children } = $props();
	// convex-svelte disables networking on the server while preserving child context.
	if (convexUrl) {
		setupConvex(convexUrl);
		setupAuth(() => ({
			isLoading: auth.loading,
			isAuthenticated: !!auth.session,
			fetchAccessToken: async ({ forceRefreshToken }) =>
				auth.session?.getToken({ template: 'convex', skipCache: forceRefreshToken }) ?? null
		}));
	}
	onMount(() => {
		let dispose: (() => void) | undefined;
		let disposed = false;
		void loadAuth().then((cleanup) => {
			if (disposed) cleanup?.();
			else dispose = cleanup;
		});
		return () => {
			disposed = true;
			dispose?.();
		};
	});
</script>

<a class="skip" href="#main">Skip to content</a>
<header class="shell site-header">
	<a href={resolve('/')} data-sveltekit-preload-code="hover" class="brand">beatcode</a>
	<nav aria-label="Main navigation">
		<a
			href={resolve('/')}
			data-sveltekit-preload-code="hover"
			aria-current={page.url.pathname === '/' ? 'page' : undefined}>Overview</a
		>
		<span class="nav-rooms">
			{#if auth.session}
				<a href={resolve('/play')} aria-current={page.url.pathname === '/play' ? 'page' : undefined}
					>Rooms</a
				>
			{/if}
		</span>
		<a
			href={resolve('/settings')}
			data-sveltekit-preload-code="hover"
			aria-current={page.url.pathname === '/settings' ? 'page' : undefined}>Settings</a
		>
		<a href={resolve('/sign-in')} data-sveltekit-preload-code="hover" class="nav-signin"
			>{auth.session ? 'Account' : 'Sign in'}</a
		>
	</nav>
</header>
<main id="main" tabindex="-1">{@render children()}</main>

<style>
	.site-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding-block: 0.75rem;
		border-bottom: 1px solid var(--border);
		flex-wrap: wrap;
	}
	.brand {
		flex-wrap: wrap;
		max-width: 100%;
		display: inline-flex;
		gap: 0.6rem;
		align-items: center;
		min-height: 44px;
		font-size: 1.75rem;
		font-family: var(--font-heading);
		font-weight: 700;
		letter-spacing: -0.02em;
		text-decoration: none;
	}
	nav {
		display: flex;
		gap: clamp(0.6rem, 2vw, 1.75rem);
		align-items: center;
		font-size: 0.875rem;
		flex-wrap: wrap;
	}
	nav a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		gap: 0.5rem;
		text-decoration: none;
	}
	nav [aria-current] {
		color: var(--primary);
		text-decoration: underline;
	}
	.nav-rooms {
		min-inline-size: 2.8rem;
		min-block-size: 44px;
	}
	.nav-signin {
		min-inline-size: 5.5rem;
		justify-content: center;
		border: 1px solid var(--border);
		padding: 0.4rem 0.8rem;
		border-radius: 0.2rem;
	}
	.skip {
		position: fixed;
		top: 1rem;
		left: 1rem;
		z-index: 100;
		padding: 1rem;
		color: var(--primary-foreground);
		background: var(--primary);
		transform: translateY(-200%);
	}
	.skip:focus {
		transform: translateY(0);
	}
</style>
