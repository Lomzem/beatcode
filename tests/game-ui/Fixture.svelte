<script lang="ts">
	import { setContext } from 'svelte';
	import Match from '../../src/lib/game/Match.svelte';
	import { createGameClient, gameKey } from '../../src/lib/game/client.svelte';
	import '../../src/app.css';
	setContext(gameKey, createGameClient());
</script>

<main class="shell page game-page">
	<h1>Match</h1>
	<Match id="public-match" />
</main>
