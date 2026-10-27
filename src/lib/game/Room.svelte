<script lang="ts">
	import { Effect } from 'effect';
	import { optionalStorage } from '#lib/auth/storage.js';
	import { resolve } from '$app/paths';
	import { getContext } from 'svelte';
	import { useQuery } from 'convex-svelte';
	import { goto } from '$app/navigation';
	import type { Id } from '../../../convex/_generated/dataModel';
	import {
		api,
		gameKey,
		cardCatalog,
		explain,
		keepPresence,
		type GameClient,
		type CardId
	} from './client.svelte';
	let { id }: { id: string } = $props();
	const game = getContext<GameClient>(gameKey);
	const query = useQuery(api.rooms.view, () => ({ roomId: id as Id<'rooms'> }));
	let selection = $state<CardId[]>([]);
	let deckLoaded = $state('');
	let invite = $state('');
	let confirmed = $state(false);
	const room = $derived(query.data);
	const dirty = $derived(
		!!room &&
			(selection.length !== room.ownDeck.length ||
				selection.some((card) => !room.ownDeck.includes(card)))
	);
	const ownReady = $derived(!!room?.ready[room.seat]);
	const cardSummary: Record<CardId, string> = {
		light_mode: 'Light palette for 20s; high contrast exempt.',
		no_paste: 'No editor paste or drop for 20s.',
		no_hints: 'No suggestions or auto-indent for 20s.',
		brain_teaser: 'Blocks scored submissions up to 15s; samples available.',
		strict_compile: 'Next scored submission within 30s: ISO C++20 + -pedantic-errors.'
	};
	keepPresence(game, () => (room?.status !== 'closed' ? room?.roomId : undefined));
	$effect(() => {
		if (room && deckLoaded !== room.roomId + room.status) {
			selection = [...room.ownDeck];
			deckLoaded = room.roomId + room.status;
		}
	});
	$effect(() => {
		if (room?.status === 'in_match' && room.currentMatchId)
			void Effect.runPromise(
				game.navigate(() =>
					goto(resolve('/match/[id]', { id: room.currentMatchId! }), { replaceState: true })
				)
			);
	});
	$effect(() => {
		if (room?.status !== 'open') return;
		const token = Effect.runSync(
			optionalStorage(() => sessionStorage.getItem('beatcode.invite.' + room.roomId), null)
		);
		if (token) invite = location.origin + '/join#' + room.roomId + '.' + token;
	});
	function regenerate() {
		const current = room;
		if (!current) return;
		return Effect.runPromise(
			Effect.gen(function* () {
				const result = yield* game.mutate('Generate invitation', api.rooms.regenerateInvite, {
					roomId: current.roomId
				});
				if (!result) return;
				invite = location.origin + '/join#' + current.roomId + '.' + result.inviteToken;
				yield* optionalStorage(
					() => sessionStorage.setItem('beatcode.invite.' + current.roomId, result.inviteToken),
					undefined
				);
			})
		);
	}
	function copy() {
		return Effect.runPromise(
			Effect.tryPromise({
				try: () => navigator.clipboard.writeText(invite),
				catch: () => 'clipboard_unavailable' as const
			}).pipe(
				Effect.match({
					onSuccess: () => {
						game.state.message = 'Invitation copied.';
					},
					onFailure: () => {
						game.state.error = 'Copy is unavailable. Select and copy the invitation link below.';
					}
				})
			)
		);
	}

	function rematch() {
		const current = room;
		if (!current) return;
		return Effect.runPromise(
			Effect.gen(function* () {
				const result = yield* game.mutate('Request rematch', api.rooms.requestRematch, {
					roomId: current.roomId
				});
				if (result !== undefined)
					game.state.message = 'Rematch requested. Waiting for your opponent.';
			})
		);
	}
	function leave() {
		const current = room;
		if (!current) return;
		return Effect.runPromise(
			Effect.gen(function* () {
				const result = yield* game.mutate(
					current.seat === 'host' ? 'Close room' : 'Leave room',
					current.seat === 'host' ? api.rooms.close : api.rooms.leave,
					{ roomId: current.roomId }
				);
				if (result !== undefined) yield* game.navigate(() => goto(resolve('/play')));
			})
		);
	}
	const blocked = $derived(!!game.state.pending || !game.state.connected);
</script>

{#if query.error}<p role="alert">{explain(query.error)}</p>
	<a class="game-button" href={resolve('/play')}>Return to play</a>
{:else if !room}<p role="status">Loading room…</p>
{:else}
	<div class="game-actions">
		<a href={resolve('/play')}>Rooms</a><span>Room: {room.status.replaceAll('_', ' ')}</span>
	</div>
	<section class="panel">
		<h2>Players</h2>
		<ul>
			{#each [{ seat: 'host' as const, player: room.host }, { seat: 'guest' as const, player: room.guest }] as entry (entry.seat)}<li
				>
					{entry.player?.displayName ?? 'Waiting for opponent'}
					{entry.player?.playerId === room.playerId ? '(you)' : ''} — {entry.player
						? game.state.serverNow - (room.lastSeen[entry.seat] ?? 0) < 60000
							? 'Connected recently'
							: 'Away'
						: 'Seat open'}{room.status === 'lobby' && entry.player
						? room.ready[entry.seat]
							? ' · Ready'
							: ' · Not ready'
						: ''}
				</li>{/each}
		</ul>
	</section>
	{#if room.status === 'open' && room.seat === 'host'}
		<section class="panel">
			<h2>Invite your opponent</h2>
			<p>
				One guest can use this link. It expires after 24 hours. Generate a new invitation if you
				lost it or your opponent left.
			</p>
			{#if invite}<label class="field"
					>Invitation link<input
						readonly
						value={invite}
						onclick={(e) => e.currentTarget.select()}
					/></label
				><button class="game-button" onclick={copy}>Copy invitation</button>{/if}<button
				class="game-button"
				disabled={blocked}
				onclick={regenerate}>Generate new invitation</button
			>
		</section>
	{:else if room.status === 'lobby'}
		<section class="panel">
			<h2>Choose your deck</h2>
			<div class="deck-actions">
				<p>
					{selection.length} of 4 selected ·
					<span role="status"
						>{dirty
							? 'Unsaved deck changes'
							: room.ownDeck.length === 4
								? 'Deck saved'
								: 'Choose four cards, then save'}</span
					>
				</p>
				<div class="game-actions">
					<button
						class="game-button"
						disabled={blocked || ownReady || selection.length !== 4 || !dirty}
						onclick={() =>
							game.run('Save deck', api.decks.set, {
								roomId: room.roomId,
								cardIds: [...selection]
							})}>Save deck</button
					>
					<button
						class="game-button primary"
						disabled={blocked || (!ownReady && (dirty || room.ownDeck.length !== 4))}
						onclick={() =>
							game.run('Update readiness', api.rooms.setReady, {
								roomId: room.roomId,
								ready: !ownReady
							})}>{ownReady ? 'Cancel ready' : 'Ready'}</button
					>
				</div>
				<p>
					{ownReady
						? 'Deck locked. Cancel ready to edit.'
						: dirty || room.ownDeck.length !== 4
							? 'Save your selection before Ready.'
							: 'Your saved deck is ready.'} Both ready: the server starts the match after three seconds.
				</p>
			</div>
			<fieldset disabled={blocked || ownReady}>
				<legend>Choose exactly four cards</legend>
				<div class="deck-grid">
					{#each cardCatalog as card (card.id)}
						<div class="deck-choice">
							<label class="deck-card"
								><input type="checkbox" value={card.id} bind:group={selection} />
								<span
									><strong>{card.name} · {card.cost} power</strong><span
										>{cardSummary[card.id]}</span
									></span
								>
							</label>
							<details>
								<summary>{card.name} details</summary>
								<p>{card.description}</p>
								<p>{card.enforcement}. One use per round.</p>
							</details>
						</div>
					{/each}
				</div>
			</fieldset>
		</section>
	{:else if room.status === 'results'}
		<section class="panel">
			<h2>Match finished</h2>
			{#if room.currentMatchId}<a
					class="game-button"
					href={resolve('/match/[id]', { id: room.currentMatchId })}>View match result</a
				>{/if}<button class="game-button" disabled={blocked} onclick={rematch}
				>Request rematch</button
			>
		</section>
	{:else if room.status === 'closed'}<p role="status">
			This room is closed. Create a new room or ask your host for another invitation.
		</p>
		<a class="game-button" href={resolve('/play')}>Return to play</a>{/if}
	{#if room.status !== 'closed' && room.status !== 'in_match'}<details>
			<summary>{room.seat === 'host' ? 'Close room' : 'Leave room'}</summary>
			<p>
				{room.seat === 'host'
					? 'Closing ends this room and invalidates the invitation.'
					: 'Leaving opens your seat. You will need a new invitation to return.'}
			</p>
			<label class="game-actions"
				><input type="checkbox" bind:checked={confirmed} />I understand</label
			><button class="game-button" disabled={blocked || !confirmed} onclick={leave}
				>Confirm {room.seat === 'host' ? 'close' : 'leave'}</button
			>
		</details>{/if}
{/if}

<style>
	section + section {
		margin-top: 1.25rem;
	}
	fieldset {
		border: 0;
		padding: 0;
		min-width: 0;
	}
	legend {
		padding-block: 0.75rem;
	}
	.deck-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
		gap: 0;
	}
	.deck-card {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.5rem 0;
		cursor: pointer;
	}
	.deck-card span span {
		display: block;
		margin-top: 0.25rem;
		line-height: 1.4;
	}
	.deck-choice {
		border-bottom: 1px solid var(--border);
		padding-block: 0.5rem;
	}
	.deck-choice details {
		margin-inline-start: 2rem;
	}
	.deck-actions {
		margin-block: 1rem;
		padding: 1rem;
		background: var(--primary);
		color: var(--primary-foreground);
	}
	.deck-actions .game-button {
		background: var(--primary-foreground);
		color: var(--primary);
		border-color: currentColor;
	}
	.deck-actions .game-button:focus-visible {
		outline-color: var(--primary-foreground);
	}
	.deck-actions p:first-child {
		margin-top: 0;
	}
	.deck-actions p:last-child {
		margin-bottom: 0;
	}
	li {
		line-height: 2;
	}
</style>
