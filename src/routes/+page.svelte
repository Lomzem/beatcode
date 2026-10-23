<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '#lib/components/ui/button/index.js';
	import { auth } from '#lib/auth/client.svelte.js';
</script>

<svelte:head>
	<title>Beatcode</title>
	<meta
		name="description"
		content="Private 1v1 C++ programming matches with hidden tests and debuff cards."
	/>
</svelte:head>
<div class="shell page overview">
	<h1>Rooms</h1>
	<div class="room-entry">
		<div class="action-rail">
			{#if auth.session}
				<Button href={resolve('/play')}>Open rooms</Button>
			{:else}
				<Button href={resolve('/sign-in')}>Sign in to play</Button>
			{/if}
		</div>
		<div class="room-guidance">
			<p>Joining a friend? Open their invitation link.</p>
			<p class="muted">To create a room, redeem a host pass in Rooms.</p>
			<details>
				<summary>Match rules</summary>
				<dl>
					<div>
						<dt>Players</dt>
						<dd>Private 1v1</dd>
					</div>
					<div>
						<dt>Language</dt>
						<dd>C++20</dd>
					</div>
					<div>
						<dt>Format</dt>
						<dd>Best of three, 10 minutes per round</dd>
					</div>
					<div>
						<dt>Winner</dt>
						<dd>Earliest submitted solution that passes all hidden tests</dd>
					</div>
				</dl>
				<p>
					Select four debuff cards before the match. Spend power to play them against your opponent;
					each card is available once per round.
				</p>
			</details>
		</div>
	</div>
</div>

<style>
	.overview {
		max-width: 64rem;
	}
	h1 {
		margin-bottom: 1.25rem;
	}
	.room-entry {
		display: grid;
		grid-template-columns: minmax(12rem, 1fr) minmax(0, 2fr);
		gap: 2rem;
		align-items: start;
	}
	.action-rail {
		display: flex;
		align-items: center;
		padding: 1.5rem;
		background: var(--primary);
		color: var(--primary-foreground);
	}
	.action-rail :global(.cn-button) {
		width: 100%;
		min-height: 4rem;
		transition: none;
		font-family: var(--font-heading);
		font-size: 1.7rem;
		line-height: 1.1;
		background: var(--primary-foreground);
		color: var(--primary);
		border-color: currentColor;
		border-radius: 0.2rem;
	}
	.action-rail :global(.cn-button:focus-visible) {
		outline-color: var(--primary-foreground);
	}
	.room-guidance {
		padding-top: 0.75rem;
	}
	p {
		max-width: 65ch;
		margin-bottom: 0.75rem;
	}
	details {
		margin-top: 1.5rem;
	}
	summary {
		min-height: 44px;
		padding-block: 0.65rem;
		cursor: pointer;
		font-weight: 700;
	}
	dl {
		margin-block: 0.75rem 1rem;
	}
	dl > div {
		display: grid;
		grid-template-columns: minmax(5rem, 1fr) minmax(0, 3fr);
		gap: 1rem;
		padding-block: 0.5rem;
	}
	dt {
		color: var(--muted-foreground);
	}
	dd {
		margin: 0;
	}
	@media (max-width: 639px) {
		.room-entry {
			grid-template-columns: 1fr;
			gap: 1rem;
		}
		.action-rail {
			padding: 1rem;
		}
		.room-guidance {
			padding: 0;
		}
		dl > div {
			grid-template-columns: 1fr;
			gap: 0.25rem;
		}
	}
	@media (forced-colors: active) {
		.action-rail {
			border: 1px solid CanvasText;
		}
	}
</style>
