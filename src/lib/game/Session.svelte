<script lang="ts">
	import { resolve } from '$app/paths';
	import { setContext, type Snippet } from 'svelte';
	import { api, createGameClient, gameKey, explain } from './client.svelte';
	let { children }: { children: Snippet } = $props();
	const game = createGameClient();
	setContext(gameKey, game);
	let name = $state('');
</script>

{#if game.session.isLoading}
	<p role="status">Verifying your match session…</p>
{:else if !game.session.isAuthenticated}
	<section class="panel">
		<h2>Match session unavailable</h2>
		<p role="status">
			The match service has not verified your account. Check your connection, reload, or sign in
			again.
		</p>
		<a class="game-button" href={resolve('/sign-in')}>Return to sign-in</a><button
			class="game-button"
			onclick={() => location.reload()}>Reload</button
		>
	</section>
{:else if game.me.error}
	<p role="alert">{explain(game.me.error)}</p>
	<button class="game-button" onclick={() => location.reload()}>Reload</button>
{:else if game.me.isLoading}
	<p role="status">Loading your player profile…</p>
{:else if !game.me.data}
	<section class="panel">
		<h2>Choose your nickname</h2>
		<form
			onsubmit={async (e) => {
				e.preventDefault();
				await game.run('Save nickname', api.players.ensure, { displayName: name });
			}}
		>
			<label class="field"
				>Nickname<input
					required
					minlength="2"
					maxlength="24"
					bind:value={name}
					autocomplete="nickname"
					aria-describedby="nickname-help"
				/></label
			>
			<p id="nickname-help">2–24 characters. Your opponent sees this name, never your email.</p>
			<button class="game-button" disabled={!!game.state.pending || !game.state.connected}
				>Save nickname</button
			>
		</form>
	</section>
{:else}
	{#if !game.state.connected}<p role="status">
			Reconnecting… Actions wait for a connection. Your local source draft remains available.
		</p>{/if}
	{@render children()}
{/if}
{#if game.state.error}<p class="error" role="alert">{game.state.error}</p>{/if}
<p class="game-live" role="status" aria-live="polite">
	{game.state.pending ? game.state.pending + '…' : game.state.message}
</p>
