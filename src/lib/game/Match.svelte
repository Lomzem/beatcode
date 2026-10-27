<script lang="ts">
	import { Effect } from 'effect';
	import { CARD_RULES } from '../../../shared/cards';
	import { optionalStorage } from '#lib/auth/storage.js';
	import { resolve } from '$app/paths';
	import { getContext, onMount } from 'svelte';
	import { useQuery } from 'convex-svelte';
	import type { Id } from '../../../convex/_generated/dataModel';
	import {
		api,
		gameKey,
		cardCatalog,
		explain,
		keepPresence,
		timeLeft,
		type GameClient,
		type CardId
	} from './client.svelte';
	import Editor from './Editor.svelte';
	let { id }: { id: string } = $props();
	const game = getContext<GameClient>(gameKey);
	const query = useQuery(api.matches.view, () => ({ matchId: id as Id<'matches'> }));
	const match = $derived(query.data);
	const roomQuery = useQuery(api.rooms.view, () => (match ? { roomId: match.roomId } : 'skip'));
	const room = $derived(roomQuery.data);
	keepPresence(game, () => match?.roomId);
	let source = $state('');
	let tab = $state('Problem');
	let wide = $state(false);
	let mobile = $state(false);
	let keyboardOpen = $state(false);
	let announceAffordable = false;
	let affordableBefore: string[] = [];
	let lastVerdict = '';
	let lastPresence = '';
	let answer = $state('');
	let confirmation: HTMLDialogElement = $state()!;
	let confirmAction = $state<'concede' | 'share'>('concede');
	let requester: HTMLElement | null = null;
	let seenEffects = new Set<string>();
	let previousRound = '';
	let clockMilestones: string[] = [];
	let retry = $state<{ kind: 'sample' | 'scored'; source: string; key: string } | null>(null);
	let restoredRequestKey = '';
	let sampleCooldown = $state(0);
	let scoredCooldown = $state(0);
	let nextCardAt = $state(0);
	let readyRequested = $state('');
	let rematchRequested = $state(false);
	const tabs = ['Problem', 'Code', 'Cards', 'Results'];
	const round = $derived(match?.round);
	const own = $derived(match?.players.find((p) => p.playerId === match.playerId));
	const opponent = $derived(match?.players.find((p) => p.playerId !== match.playerId));
	const now = $derived(game.state.serverNow);
	const active = $derived(match?.status === 'active' && round?.status === 'active');
	const effects = $derived(match?.effects.filter((e) => e.endsAt > now) ?? []);
	const incoming = $derived(effects.filter((e) => e.targetId === match?.playerId));
	const challenge = $derived(incoming.find((e) => e.cardId === 'brain_teaser'));
	const diagnostics = $derived(
		match?.ownSubmissions.at(-1)?.diagnostics ?? match?.ownSampleRuns.at(-1)?.diagnostics ?? ''
	);
	const blocked = $derived(!!game.state.pending || !game.state.connected);
	const power = $derived(
		own && round
			? Math.min(
					10,
					own.power + Math.max(0, Math.floor((now - round.startsAt) / 10000) - own.powerTick)
				)
			: 0
	);
	const otherSeen = $derived(
		room ? (room.lastSeen[room.seat === 'host' ? 'guest' : 'host'] ?? 0) : 0
	);
	const pendingScored = $derived(match?.ownSubmissions.some((s) => s.status === 'pending'));
	const pendingSample = $derived(match?.ownSampleRuns.some((s) => s.status === 'pending'));
	onMount(() => {
		const media = matchMedia('(min-width: 1024px)');
		const small = matchMedia('(max-width:639px)');
		const viewport = window.visualViewport;
		const updateViewport = () => {
			mobile = small.matches;
			keyboardOpen = !!viewport && viewport.height < window.innerHeight * 0.75;
		};
		updateViewport();
		viewport?.addEventListener('resize', updateViewport);
		window.addEventListener('resize', updateViewport);
		announceAffordable = Effect.runSync(
			optionalStorage(() => localStorage.getItem('beatcode.announcements') === 'affordable', false)
		);
		const update = () => {
			wide = media.matches;
		};
		update();
		media.addEventListener('change', update);
		return () => {
			media.removeEventListener('change', update);
			viewport?.removeEventListener('resize', updateViewport);
			window.removeEventListener('resize', updateViewport);
		};
	});
	$effect(() => {
		if (!match) return;
		const current = new Set<string>(effects.map((e) => e.effectId));
		const additions = effects
			.filter((e) => !seenEffects.has(e.effectId))
			.map(
				(e) =>
					`${cardCatalog.find((c) => c.id === e.cardId)?.name} on ${e.targetId === match.playerId ? 'you' : 'your opponent'}`
			);
		if (additions.length) game.state.message = additions.join('. ') + '.';
		else if ([...seenEffects].some((id) => !current.has(id)))
			game.state.message = 'A card effect ended.';
		seenEffects = current;
	});
	$effect(() => {
		if (!round) return;
		const phase = round.roundId + round.status;
		if (phase !== previousRound) {
			previousRound = phase;
			game.state.message =
				round.status === 'settling'
					? 'Settling this round. Pending verdicts are withheld until the server decides the result.'
					: `Round ${round.index}: ${round.status}.`;
		}
		const remaining = Math.ceil((round.endsAt - now) / 1000);
		for (const milestone of [300, 60, 30, 10]) {
			const key = round.roundId + ':' + milestone;
			if (
				active &&
				remaining <= milestone &&
				remaining > milestone - 2 &&
				!clockMilestones.includes(key)
			) {
				clockMilestones.push(key);
				game.state.message = `${milestone} seconds remaining.`;
			}
		}
	});
	$effect(() => {
		if (!round || !match) return;
		const storageKey = `beatcode.request:${match.playerId}:${round.roundId}`;
		if (restoredRequestKey === storageKey) return;
		restoredRequestKey = storageKey;
		retry = Effect.runSync(
			optionalStorage(() => {
				const value = localStorage.getItem(storageKey);
				const parsed: unknown = value ? JSON.parse(value) : null;
				if (
					!parsed ||
					typeof parsed !== 'object' ||
					!('kind' in parsed) ||
					(parsed.kind !== 'sample' && parsed.kind !== 'scored') ||
					!('source' in parsed) ||
					typeof parsed.source !== 'string' ||
					!('key' in parsed) ||
					typeof parsed.key !== 'string' ||
					!parsed.key
				)
					return null;
				return { kind: parsed.kind, source: parsed.source, key: parsed.key };
			}, null)
		);
	});
	$effect(() => {
		if (!match) return;
		const verdicts = match.ownSubmissions
			.map((s) => `${s.seq}: ${s.verdict ?? s.status}`)
			.join(', ');
		if (verdicts && verdicts !== lastVerdict) {
			lastVerdict = verdicts;
			game.state.message = 'Your submissions: ' + verdicts + '.';
		}
		const presence = now - otherSeen < 60000 ? 'connected recently' : 'away';
		if (lastPresence && lastPresence !== presence) game.state.message = `Opponent ${presence}.`;
		lastPresence = presence;
		if (announceAffordable) {
			const affordable = cardCatalog
				.filter(
					(c) => room?.ownDeck.includes(c.id) && c.cost <= power && !own?.usedCards.includes(c.id)
				)
				.map((c) => c.name);
			const newly = affordable.filter((c) => !affordableBefore.includes(c));
			if (newly.length) game.state.message = 'Affordable cards: ' + newly.join(', ') + '.';
			affordableBefore = affordable;
		}
	});

	function requestStore() {
		if (!match || !round) return;
		Effect.runSync(persistRequest(`beatcode.request:${match.playerId}:${round.roundId}`, retry));
	}
	function persistRequest(key: string, request: typeof retry) {
		return optionalStorage(() => {
			if (request) localStorage.setItem(key, JSON.stringify(request));
			else localStorage.removeItem(key);
		}, undefined);
	}
	function submit(kind: 'sample' | 'scored') {
		const currentRound = round;
		if (!currentRound || !match || !active || (!retry && !source.trim())) return;
		if (retry && retry.kind !== kind) {
			game.state.error =
				'Retry the previous request first, or dismiss it before making a different request.';
			return;
		}
		retry ??= { kind, source, key: crypto.randomUUID() };
		const request = retry;
		const storageKey = `beatcode.request:${match.playerId}:${currentRound.roundId}`;
		return Effect.runPromise(
			Effect.gen(function* () {
				yield* persistRequest(storageKey, request);
				const result =
					kind === 'sample'
						? yield* game.mutate('Run samples', api.samples.run, {
								roundId: currentRound.roundId,
								source: request.source,
								clientRunId: request.key
							})
						: yield* game.mutate('Submit solution', api.submissions.submit, {
								roundId: currentRound.roundId,
								source: request.source,
								clientSubmitId: request.key
							});
				if (!result) return;
				yield* persistRequest(storageKey, null);
				if (round?.roundId !== currentRound.roundId || retry?.key !== request.key) return;
				retry = null;
				if (kind === 'sample') sampleCooldown = now + 5000;
				else scoredCooldown = now + 3000;
				game.state.message = kind === 'sample' ? 'Sample run queued.' : 'Scored submission queued.';
			})
		);
	}
	function play(cardId: CardId) {
		const current = round;
		if (!current) return;
		return Effect.runPromise(
			Effect.gen(function* () {
				const result = yield* game.mutate('Play card', api.cards.play, {
					roundId: current.roundId,
					cardId,
					clientPlayId: crypto.randomUUID()
				});
				if (result && round?.roundId === current.roundId)
					nextCardAt = result.endsAt - CARD_RULES[cardId].duration + 2000;
			})
		);
	}

	function cardReason(card: (typeof cardCatalog)[number]) {
		if (!active) return 'Round inactive';
		if (own?.usedCards.includes(card.id)) return 'Used this round';
		if (nextCardAt > now) return 'Card cooldown';
		if (power < card.cost) return 'More power needed';
		return 'Ready';
	}
	function openConfirmation(action: 'concede' | 'share', event: MouseEvent) {
		confirmAction = action;
		requester = event.currentTarget as HTMLElement;
		confirmation.showModal();
		confirmation.querySelector('button')?.focus();
	}
	function closeConfirmation() {
		confirmation.close();
		requester?.focus();
	}
	function confirm() {
		if (!match) return;
		closeConfirmation();
		return game.run(
			confirmAction === 'concede' ? 'Concede match' : 'Share source',
			confirmAction === 'concede' ? api.matches.concede : api.matches.shareSource,
			{ matchId: match.matchId }
		);
	}
	function readyNext() {
		const current = round;
		if (!current) return;
		return Effect.runPromise(
			Effect.gen(function* () {
				const result = yield* game.mutate('Ready for next round', api.rounds.readyNext, {
					roundId: current.roundId
				});
				if (result !== undefined) readyRequested = current.roundId;
			})
		);
	}
	function rematch() {
		const current = match;
		if (!current) return;
		return Effect.runPromise(
			Effect.gen(function* () {
				const result = yield* game.mutate('Request rematch', api.rooms.requestRematch, {
					roomId: current.roomId
				});
				if (result !== undefined) {
					rematchRequested = true;
					game.state.message = 'Rematch requested. Return to the room when your opponent agrees.';
				}
			})
		);
	}
	function answerChallenge(event: SubmitEvent) {
		event.preventDefault();
		const current = round;
		const effect = challenge;
		if (!current || !effect) return;
		return Effect.runPromise(
			Effect.gen(function* () {
				const result = yield* game.mutate('Answer challenge', api.cards.answerChallenge, {
					roundId: current.roundId,
					effectId: effect.effectId,
					answer: Number(answer)
				});
				if (result) {
					game.state.message = result.solved
						? 'Brain teaser solved.'
						: 'Incorrect answer. Try again.';
					answer = '';
				}
			})
		);
	}

	function switchTab(event: KeyboardEvent) {
		const index = tabs.indexOf(tab);
		const next =
			event.key === 'ArrowRight'
				? (index + 1) % 4
				: event.key === 'ArrowLeft'
					? (index + 3) % 4
					: event.key === 'Home'
						? 0
						: event.key === 'End'
							? 3
							: -1;
		if (next >= 0) {
			event.preventDefault();
			tab = tabs[next];
			document.getElementById('tab-' + tab)?.focus();
		}
	}
	const light = $derived(incoming.some((e) => e.cardId === 'light_mode'));
	$effect(() => {
		if (!light) return;
		const root = document.documentElement;
		const saved = root.dataset.theme;
		if (
			saved === 'contrast' ||
			matchMedia('(prefers-contrast: more), (forced-colors: active)').matches
		)
			return;
		root.dataset.theme = 'light';
		return () => {
			if (saved) root.dataset.theme = saved;
			else delete root.dataset.theme;
		};
	});
</script>

{#if query.error}<p role="alert">{explain(query.error)}</p>
	<a class="game-button" href={resolve('/play')}>Return to play</a>
{:else if !match || !round}<p role="status">Loading match…</p>
{:else}
	<div class="match-summary panel">
		<div>
			<strong>Round {round.index} · {round.status}</strong>
			<p>
				<span class="sr-only">Round clock:</span>
				{game.state.clockReady
					? timeLeft(round.status === 'intermission' ? round.startsAt : round.endsAt, now)
					: 'Syncing clock…'}{round.status === 'intermission' ? ' until start' : ''}
			</p>
		</div>
		<div>
			<strong
				>{match.players[0].displayName}
				{match.wins.a} — {match.wins.b}
				{match.players[1].displayName}</strong
			>
			<p>
				{opponent?.displayName}: {now - otherSeen < 60000
					? 'connected recently'
					: 'away'}{match.opponentPending === true ? ' · Submission pending' : ''}
			</p>
		</div>
		<div>
			<strong>Power {power} of 10</strong>
			<p>
				Next power in {round.status === 'active'
					? 10 - (((Math.floor((now - round.startsAt) / 1000) % 10) + 10) % 10)
					: '—'} seconds
			</p>
		</div>
	</div>
	<section class="live-effects" aria-labelledby="effects-heading">
		<h2 id="effects-heading">Active effects</h2>
		{#if effects.length}<ul>
				{#each effects as effect (effect.effectId)}<li>
						{cardCatalog.find((c) => c.id === effect.cardId)?.name} on {effect.targetId ===
						match.playerId
							? 'you'
							: 'opponent'} · {timeLeft(effect.endsAt, now)}
					</li>{/each}
			</ul>{:else}<p>No active effects.</p>{/if}
		{#if challenge}<p>Brain teaser blocks scored submissions; samples remain available.</p>{/if}
		{#if incoming.some((e) => e.cardId === 'strict_compile')}<p>
				Next scored submission: ISO C++20 + -pedantic-errors. Samples do not consume this effect.
			</p>{/if}
	</section>
	<p>
		{!active
			? 'Submissions wait for an active round.'
			: pendingScored
				? 'Scored submission pending.'
				: challenge
					? 'Solve the brain teaser to submit.'
					: scoredCooldown > now
						? 'Submission cooldown.'
						: ''}{pendingSample ? ' Sample run pending.' : ''}
	</p>

	{#if round.status === 'settling'}<section class="panel">
			<h2>Settling round</h2>
			<p>
				Waiting for admitted submissions. Passing submissions and opponent pending state are
				withheld until the server settles the result.
			</p>
		</section>{/if}
	{#if round.status === 'intermission'}<section class="panel">
			<h2>Intermission</h2>
			<p>
				Next round starts in {timeLeft(round.startsAt, now)}. Cards and power reset each round. Your
				source stays on this device.
			</p>
			<button
				class="game-button"
				disabled={blocked || readyRequested === round.roundId}
				onclick={readyNext}>Ready for next round</button
			>
		</section>{/if}
	{#if match.status === 'finished'}<section class="panel">
			<h2>Match result</h2>
			<p>
				{match.result === 'win'
					? `${match.players.find((p) => p.playerId === match.winnerId)?.displayName ?? 'Player'} wins.`
					: match.result === 'draw'
						? 'Match drawn.'
						: 'Match aborted. No competitive result.'}
				{match.reason ? `Reason: ${match.reason.replaceAll('_', ' ')}.` : ''}
			</p>
			<div class="game-actions">
				<a class="game-button" href={resolve('/room/[id]', { id: match.roomId })}>Return to room</a
				><button class="game-button" disabled={blocked || rematchRequested} onclick={rematch}
					>Request rematch</button
				><button
					class="game-button"
					disabled={blocked}
					onclick={(e) => openConfirmation('share', e)}>Share my source</button
				>
			</div>
		</section>{/if}
	<div class="game-actions" role="tablist" aria-label="Match panels" hidden={wide}>
		{#each tabs as name (name)}<button
				id={'tab-' + name}
				role="tab"
				class="game-button"
				aria-selected={tab === name}
				aria-controls={'panel-' + name}
				tabindex={tab === name ? 0 : -1}
				onclick={() => (tab = name)}
				onkeydown={switchTab}>{name}</button
			>{/each}
	</div>
	<div class="match-grid">
		<section
			id="panel-Problem"
			role={wide ? 'region' : 'tabpanel'}
			aria-labelledby={wide ? 'problem-heading' : 'tab-Problem'}
			hidden={!wide && tab !== 'Problem'}
			class="panel"
		>
			<h2 id="problem-heading">{match.problem?.title ?? 'Problem unavailable'}</h2>
			{#if match.problem}<pre class="statement">{match.problem.statementMd}</pre>
				<p>
					Time limit: {match.problem.limits.timeMs} ms · Memory: {match.problem.limits.memoryMiB} MiB
				</p>
				<h3>Samples</h3>
				{#each match.problem.samples as sample, index (index)}<h4>Sample {index + 1}</h4>
					<strong>Input</strong>
					<pre>{sample.input}</pre>
					<strong>Expected output</strong>
					<pre>{sample.output}</pre>{/each}{/if}
		</section>
		<section
			id="panel-Code"
			role={wide ? 'region' : 'tabpanel'}
			aria-labelledby={wide ? 'code-heading' : 'tab-Code'}
			hidden={!wide && tab !== 'Code'}
			class="panel code-panel"
		>
			<h2 id="code-heading">Code</h2>
			{#key round.roundId}<Editor
					draftKey={`beatcode.draft:${match.playerId}:round:${round.roundId}`}
					noPaste={incoming.some((e) => e.cardId === 'no_paste')}
					noHints={incoming.some((e) => e.cardId === 'no_hints')}
					{diagnostics}
					onSource={(value) => (source = value)}
					onNotice={(value) => (game.state.message = value)}
				/>{/key}
			{#if challenge}<section class="challenge" aria-labelledby="challenge-heading">
					<h3 id="challenge-heading">Brain teaser</h3>
					<p>
						Scored submissions are blocked for {timeLeft(challenge.endsAt, now)} or until your answer
						is correct. Samples remain available.
					</p>
					<form onsubmit={answerChallenge}>
						<label class="field"
							>What is {challenge.challenge?.a} + {challenge.challenge?.b}?<input
								id="challenge-answer"
								type="number"
								step="1"
								required
								bind:value={answer}
							/></label
						><button class="game-button" disabled={blocked}>Check answer</button>
					</form>
				</section>{/if}

			{#if retry}<p>
					A {retry.kind === 'sample' ? 'sample run' : 'scored submission'} request needs confirmation.
					Retry sends the original source with the same request ID.
				</p>
				<button class="game-button" disabled={blocked} onclick={() => submit(retry!.kind)}
					>Retry original request</button
				><button
					class="game-button"
					disabled={blocked}
					onclick={() => {
						retry = null;
						requestStore();
					}}>Dismiss request</button
				>{/if}
			<div class="game-actions">
				<button
					class="game-button"
					disabled={blocked ||
						!active ||
						pendingSample ||
						!source.trim() ||
						sampleCooldown > now ||
						!!retry}
					onclick={() => submit('sample')}>Run samples</button
				><button
					class="game-button primary"
					disabled={blocked ||
						!active ||
						pendingScored ||
						!!challenge ||
						!source.trim() ||
						scoredCooldown > now ||
						!!retry}
					onclick={() => submit('scored')}>Submit solution</button
				>{#if challenge}<button
						class="game-button"
						onclick={() => document.getElementById('challenge-answer')?.focus()}
						>Go to brain teaser</button
					>{/if}
			</div>
			<details>
				<summary>Submission limits</summary>
				<p>
					Only server-accepted submissions count toward the result. Source limit: 65,536 UTF-8
					bytes.
				</p>
			</details>
		</section>
		<section
			id="panel-Cards"
			role={wide ? 'complementary' : 'tabpanel'}
			aria-labelledby={wide ? 'cards-heading' : 'tab-Cards'}
			hidden={!wide && tab !== 'Cards'}
			class="panel"
		>
			<h2 id="cards-heading">Cards</h2>
			<details>
				<summary>Power rules</summary>
				<p>
					One use per card per round. Power starts at 3, gains 1 every 10 seconds, and caps at 10.
				</p>
			</details>
			<div class="card-list">
				{#each cardCatalog.filter((c) => room?.ownDeck.includes(c.id)) as card (card.id)}<button
						class="game-button card-play"
						disabled={blocked || cardReason(card) !== 'Ready'}
						onclick={() => play(card.id)}
						><strong>{card.name} · {card.cost} power · {cardReason(card)}</strong></button
					>{/each}
			</div>
			<details>
				<summary>Card details</summary
				>{#each cardCatalog.filter((c) => room?.ownDeck.includes(c.id)) as card (card.id)}<h3>
						{card.name}
					</h3>
					<p>{card.description} {card.enforcement}.</p>{/each}
			</details>
			{#if room?.opponentDeck}<details>
					<summary>Opponent’s locked deck</summary>
					<ul>
						{#each room.opponentDeck as cardId (cardId)}<li>
								{cardCatalog.find((c) => c.id === cardId)?.name}
							</li>{/each}
					</ul>
				</details>{/if}
		</section>
		<section
			id="panel-Results"
			role={wide ? 'region' : 'tabpanel'}
			aria-labelledby={wide ? 'results-heading' : 'tab-Results'}
			hidden={!wide && tab !== 'Results'}
			class="panel results-panel"
		>
			<h2 id="results-heading">Results</h2>
			<h3>Your submissions</h3>
			{#if !match.ownSubmissions.length}<p>
					No scored submissions yet.
				</p>{/if}{#each match.ownSubmissions as submission (submission.submissionId)}<p>
					Submission {submission.seq}: {submission.verdict ??
						submission.status}{submission.sandboxTerminated ? ' · Sandbox terminated' : ''} · {submission.profile ===
					'strict'
						? 'ISO C++20 strict'
						: 'GNU C++20'}
				</p>
				{#if submission.sampleFeedback}<details>
						<summary>Public sample feedback</summary><strong>Input</strong>
						<pre>{submission.sampleFeedback.input}</pre>
						<strong>Expected</strong>
						<pre>{submission.sampleFeedback.expected}</pre>
						<strong>Actual</strong>
						<pre>{submission.sampleFeedback.actual}</pre>
					</details>{/if}{/each}
			<h3>Your sample runs</h3>
			{#each match.ownSampleRuns as run (run.sampleRunId)}<div>
					<p>{run.status === 'pending' ? 'Sample run pending' : 'Sample run ' + run.status}</p>
					{#each run.results ?? [] as result, index (index)}<p>
							Sample {index + 1}: {result.verdict}
						</p>
						<pre>{result.output}</pre>{/each}
				</div>{/each}
			<h3>Rounds</h3>
			<table>
				<caption>Server round results</caption><thead
					><tr><th scope="col">Round</th><th scope="col">Result</th></tr></thead
				><tbody
					>{#each match.rounds as history (history.roundId)}<tr
							><th scope="row">{history.index}</th><td
								>{history.outcome === 'won'
									? `${match.players.find((p) => p.playerId === history.winnerId)?.displayName} wins`
									: (history.outcome ?? history.status)}{#if history.opponentVerdicts.length}<p>
										Opponent verdicts: {history.opponentVerdicts
											.map((s) => s.verdict ?? s.status)
											.join(', ')}
									</p>{/if}{#if history.sharedSource}<details>
										<summary>Shared opponent source</summary>
										<pre>{history.sharedSource}</pre>
									</details>{/if}</td
							></tr
						>{/each}</tbody
				>
			</table>
		</section>
	</div>
	{#if match.status === 'active'}<div class="game-actions">
			<button class="game-button" disabled={blocked} onclick={(e) => openConfirmation('concede', e)}
				>Concede match</button
			>{#if otherSeen && now - otherSeen > 120000}<button
					class="game-button"
					disabled={blocked}
					onclick={() =>
						game.run('Claim forfeit', api.matches.claimForfeit, { matchId: match.matchId })}
					>Claim opponent forfeit</button
				>{/if}
		</div>{/if}
	{#if mobile && tab === 'Code' && !keyboardOpen}
		<div class="mobile-actions" role="group" aria-label="Code actions">
			<button
				class="game-button"
				disabled={blocked ||
					!active ||
					pendingSample ||
					!source.trim() ||
					sampleCooldown > now ||
					!!retry}
				onclick={() => submit('sample')}>Run samples (action bar)</button
			><button
				class="game-button primary"
				disabled={blocked ||
					!active ||
					pendingScored ||
					!!challenge ||
					!source.trim() ||
					scoredCooldown > now ||
					!!retry}
				onclick={() => submit('scored')}>Submit solution (action bar)</button
			>
		</div>
	{/if}

	<dialog
		bind:this={confirmation}
		aria-labelledby="confirmation-heading"
		onclose={() => requester?.focus()}
	>
		<h2 id="confirmation-heading">
			{confirmAction === 'concede' ? 'Concede match?' : 'Share your source?'}
		</h2>
		<p>
			{confirmAction === 'concede'
				? 'Your opponent will win this match. Your draft remains on this device.'
				: 'Your opponent will be able to read your final submitted source from every round. This cannot be undone.'}
		</p>
		<div class="game-actions">
			<button class="game-button" onclick={closeConfirmation}>Cancel</button><button
				class="game-button"
				onclick={confirm}
				>{confirmAction === 'concede' ? 'Confirm concede' : 'Confirm share source'}</button
			>
		</div>
	</dialog>
{/if}

<style>
	.live-effects {
		margin-block: 1rem;
	}
	.live-effects h2 {
		font-size: 1rem;
		margin-block: 0 0.25rem;
	}
	.live-effects ul {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1.5rem;
		padding-inline-start: 1.25rem;
		margin-block: 0;
	}
	.mobile-actions {
		position: fixed;
		inset: auto 0 0;
		z-index: 10;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding: 0.5rem;
		background: var(--background);
		border-top: 1px solid var(--border);
	}
	.mobile-actions button {
		flex: 1;
	}
	:global(.game-page:has(.mobile-actions)) {
		padding-bottom: 12rem;
	}
	:global(.game-page:has(.mobile-actions) :is(button, input, [tabindex])) {
		scroll-margin-bottom: 12rem;
	}
	@media (max-height: 32rem) {
		.mobile-actions {
			position: static;
			border-top: 0;
		}
		:global(.game-page:has(.mobile-actions)) {
			padding-bottom: 0;
		}
		:global(.game-page:has(.mobile-actions) :is(button, input, [tabindex])) {
			scroll-margin-bottom: 0;
		}
	}
	.match-summary {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem 2rem;
		margin-bottom: 1rem;
	}
	.match-summary p {
		margin: 0;
	}
	.match-grid {
		display: grid;
		gap: 1rem;
		margin-block: 1rem;
	}
	.match-grid > [hidden] {
		display: none;
	}
	.match-grid > .panel {
		padding: 1.1rem;
	}
	.statement {
		font-family: inherit;
	}
	.card-list {
		display: grid;
		gap: 0.75rem;
	}
	.card-play {
		display: grid;
		gap: 0.5rem;
		text-align: left;
		justify-content: start;
	}
	.challenge {
		border: 2px solid var(--primary);
		padding: 1rem;
		margin-top: 1rem;
	}
	dialog {
		max-width: min(32rem, calc(100% - 2rem));
		max-height: 85dvh;
		overflow: auto;
		background: var(--card);
		color: var(--foreground);
		padding: 1.5rem;
		border: 2px solid var(--border);
		border-radius: 0.75rem;
	}
	dialog::backdrop {
		background: #0009;
	}
	.results-panel {
		grid-column: 1/-1;
	}
	[role='tab'][aria-selected='true'] {
		border: 3px solid var(--primary);
		font-weight: 700;
	}
	[role='tablist'][hidden] {
		display: none;
	}
	@media (min-width: 1024px) {
		.match-grid {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, 0.8fr);
		}
	}
</style>
