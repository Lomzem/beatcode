<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { auth, authConfigured, convexUrl } from '#lib/auth/client.svelte.js';
	import Access from '#lib/game/Access.svelte';
	import Join from '#lib/game/Join.svelte';
	import { onMount } from 'svelte';
	import { rememberReturnPath } from '#lib/auth/return-path.js';
	let fragment = $state('');
	onMount(() => {
		fragment = location.hash.slice(1);
	});
	// Only a signed-out visitor with a complete invitation needs the trip back; saving
	// for a signed-in one, or a bare /join, would later bounce Account back here.
	$effect(() => {
		if (fragment && !auth.loading && !auth.session) rememberReturnPath('/join#' + fragment);
	});
</script>

<svelte:head><title>Join room — Beatcode</title></svelte:head>
<div class="shell page game-page">
	<h1>Join room</h1>
	{#if !fragment}<p class="error" role="alert">
			This invitation is missing its room and token. Open the complete invitation link from your
			host.
		</p>{:else}
		{#if (!authConfigured || !convexUrl) && !auth.session}<p>
				<a
					class="game-button"
					href={resolve(`/sign-in#next=${encodeURIComponent('/join' + page.url.hash)}`)}
					>Sign in to continue</a
				>
			</p>{/if}
		<Access><Join {fragment} /></Access>
	{/if}
</div>
