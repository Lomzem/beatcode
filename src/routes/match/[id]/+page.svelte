<script lang="ts">
	import { page } from '$app/state';
	import Access from '#lib/game/Access.svelte';
	import Match from '#lib/game/Match.svelte';
</script>

<svelte:head><title>Match — Beatcode</title></svelte:head>
<div class="shell page game-page">
	<h1>Match</h1>
	<Access><Match id={page.params.id ?? ''} /></Access>
</div>
