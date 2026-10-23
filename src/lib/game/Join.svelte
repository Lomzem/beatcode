<script lang="ts">
	import { Effect } from 'effect';
	import { resolve } from '$app/paths';
	import { getContext } from 'svelte';
	import { goto } from '$app/navigation';
	import type { Id } from '../../../convex/_generated/dataModel';
	import { api, gameKey, type GameClient } from './client.svelte';
	import { clearReturnPath } from '#lib/auth/return-path.js';
	let { fragment }: { fragment: string } = $props();
	const game = getContext<GameClient>(gameKey);
	function join() {
		return Effect.runPromise(
			Effect.gen(function* () {
				const dot = fragment.indexOf('.');
				if (dot < 1 || dot === fragment.length - 1) {
					game.state.error = 'This invitation is incomplete. Ask the host for a new link.';
					return;
				}
				const result = yield* game.mutate('Join room', api.rooms.join, {
					roomId: fragment.slice(0, dot) as Id<'rooms'>,
					inviteToken: fragment.slice(dot + 1)
				});
				if (result?.ok) {
					clearReturnPath();
					history.replaceState(null, '', '/join');
					yield* game.navigate(() =>
						goto(resolve('/room/[id]', { id: result.roomId }), { replaceState: true })
					);
				} else if (result)
					game.state.error =
						result.error.code === 'QUOTA'
							? 'Too many invitation attempts. Try again later.'
							: 'This invitation is expired, used, full, or unavailable. Ask the host for a new invitation.';
			})
		);
	}
</script>

<section class="panel">
	<h2>Join private room</h2>
	<p>You’ll join as {game.me.data?.displayName}.</p>
	<button
		class="game-button primary"
		disabled={!!game.state.pending || !game.state.connected}
		onclick={join}>Join room</button
	>
</section>
