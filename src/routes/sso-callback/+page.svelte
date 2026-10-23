<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { auth, authConfigured } from '#lib/auth/client.svelte.js';
	// Account Portal owns OAuth completion and challenges. This old application URL
	// only recovers stale links; it must never resume the legacy custom sign-up flow.
	$effect(() => {
		if (auth.session) void goto(resolve('/sign-in'), { replaceState: true });
	});
</script>

<svelte:head><title>Complete sign-in — Beatcode</title></svelte:head>
<div class="shell page prose">
	<h1>Complete sign-in</h1>
	{#if auth.loading}<p role="status">Restoring your session…</p>
	{:else if auth.error}<p role="alert">{auth.error}</p>
	{:else if !authConfigured}<p role="status">Sign-in is not configured on this installation.</p>
	{:else if !auth.session}<p role="status">
			Continue on Clerk’s sign-in page to complete sign-in.
		</p>{/if}
	<a href={resolve('/sign-in')}>Return to sign-in</a>
</div>
