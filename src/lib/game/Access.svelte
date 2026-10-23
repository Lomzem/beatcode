<script lang="ts">
	import { resolve } from '$app/paths';
	import { auth, authConfigured, convexUrl } from '#lib/auth/client.svelte.js';
	import Session from './Session.svelte';
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
</script>

{#if !authConfigured || !convexUrl}
	<section class="panel">
		<h2>Play is unavailable</h2>
		<p role="status">
			The account or match service is not configured on this installation yet. Try again after setup
			is complete.
		</p>
	</section>
{:else if auth.loading}
	<p role="status">Connecting to the account service…</p>
{:else if auth.error}
	<p role="alert">{auth.error}</p>
	<button class="game-button" onclick={() => location.reload()}>Reload and try again</button>
{:else if !auth.session}
	<section class="panel">
		<h2>Sign in to play</h2>
		<a
			class="game-button"
			href={resolve(
				`/sign-in#next=${encodeURIComponent(page.url.pathname + page.url.search + page.url.hash)}`
			)}>Sign in to continue</a
		>
	</section>
{:else}
	<Session>{@render children()}</Session>
{/if}
