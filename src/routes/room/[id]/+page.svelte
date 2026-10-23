<script lang="ts">
	import { page } from '$app/state';
	import Access from '#lib/game/Access.svelte';
	import Room from '#lib/game/Room.svelte';
</script>

<svelte:head><title>Room — Beatcode</title></svelte:head>
<div class="shell page game-page">
	<h1>Room</h1>
	<Access><Room id={page.params.id ?? ''} /></Access>
</div>
