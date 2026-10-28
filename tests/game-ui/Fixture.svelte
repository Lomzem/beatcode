<script lang="ts">
	import Match from '../../src/lib/game/Match.svelte';
	import Play from '../../src/lib/game/Play.svelte';
	import Room from '../../src/lib/game/Room.svelte';
	import Session from '../../src/lib/game/Session.svelte';
	import { selected } from './selected';
	import '../../src/app.css';
	// Mirrors the /play, /room/[id] and /match/[id] route pages inside the signed-in Session.
	const heading = { rooms: 'Play', room: 'Room', match: 'Match' }[selected.screen];
</script>

<svelte:head><title>{heading} — Beatcode</title></svelte:head>
<main class="shell page game-page">
	<h1>{heading}</h1>
	<Session>
		{#if selected.screen === 'rooms'}<Play />
		{:else if selected.screen === 'room'}<Room id="public-room" />
		{:else}<Match id="public-match" />{/if}
	</Session>
</main>
