<script lang="ts">
	import { Effect } from 'effect';
	import { optionalStorage } from '#lib/auth/storage.js';
	import { resolve } from '$app/paths';
	import { getContext } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, gameKey, type GameClient } from './client.svelte';
	const game = getContext<GameClient>(gameKey);
	let name = $derived(game.me.data?.displayName ?? '');

	function create() {
		return Effect.runPromise(
			Effect.gen(function* () {
				const result = yield* game.mutate('Create room', api.rooms.create, {});
				if (!result) return;
				yield* optionalStorage(
					() => sessionStorage.setItem('beatcode.invite.' + result.roomId, result.inviteToken),
					undefined
				);
				yield* game.navigate(() => goto(resolve('/room/[id]', { id: result.roomId })));
			})
		);
	}
</script>

<div class="game-grid">
	<section class="panel">
		<h2>Rooms</h2>
		<button
			class="game-button primary"
			disabled={!!game.state.pending || !game.state.connected}
			onclick={create}>Create room</button
		>
	</section>
	<section class="panel">
		<p>Playing as <strong>{game.me.data?.displayName}</strong></p>
		<details>
			<summary>Edit nickname</summary>
			<form
				onsubmit={async (e) => {
					e.preventDefault();
					await game.run('Save nickname', api.players.rename, { displayName: name });
				}}
			>
				<label class="field"
					>Nickname<input
						required
						minlength="2"
						maxlength="24"
						bind:value={name}
						autocomplete="nickname"
					/></label
				><button class="game-button" disabled={!!game.state.pending || !game.state.connected}
					>Save nickname</button
				>
			</form>
		</details>
	</section>
</div>
