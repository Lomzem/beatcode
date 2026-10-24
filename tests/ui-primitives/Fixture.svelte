<script lang="ts">
	import * as Select from '../../src/lib/components/ui/select/index';
	import Input from '../../src/lib/components/ui/input/input.svelte';
	import Button from '../../src/lib/components/ui/button/button.svelte';
	import { Label } from '../../src/lib/components/ui/label/index';
	// An untyped JavaScript caller can still pass an invalid file default.
	const fileDefaults: Record<string, unknown> = { value: 'previous-upload.txt' };
	let files = $state<FileList>();
	let text = $state('Initial');
	let selected = $state('1');
	const selectCase = new URLSearchParams(location.search).has('select');
	const fileCase = new URLSearchParams(location.search).has('file');
	const inlineSelectCase = new URLSearchParams(location.search).has('portal-disabled-select');
	const shortOptions = ['First', 'Second', 'Third', 'Fourth'].map((label) => ({
		value: label.toLowerCase(),
		label
	}));
	let shortSelected = $state('first');
	let disabled = $state(true);
	let actions = $state(0);
	let parentActions = $state(0);
	let receiver = $state('None');
	function activate(this: HTMLElement, event: MouseEvent & { currentTarget: HTMLElement }) {
		if (event.currentTarget instanceof HTMLAnchorElement) actions++;
		receiver = this === event.currentTarget ? this.tagName : 'mismatch';
		this.focus();
		return false;
	}
</script>

<svelte:window
	onclick={(event) => {
		if (event.target instanceof Element && event.target.closest('[data-action-region]'))
			parentActions++;
	}}
/>
<main style="padding: 24px; max-width: 32rem">
	<h1>Primitive regression fixture</h1>
	{#if fileCase}
		<label for="upload">Upload solution</label>
		<Input id="upload" type="file" bind:files {...fileDefaults} />
		<output aria-label="Selected file">{files?.[0]?.name ?? 'None'}</output>
		<button onclick={() => (files = new DataTransfer().files)}>Clear upload</button>
		<label for="text">Description</label>
		<Input id="text" bind:value={text} />
		<output aria-label="Description value">{text}</output>
	{:else if selectCase}
		<Select.Root type="single" bind:value={selected}>
			<Select.Trigger aria-label="Problem">Problem {selected}</Select.Trigger>
			<Select.Content>
				{#each Array.from({ length: 30 }, (_, index) => String(index + 1)) as value (value)}
					<Select.Item {value} label={`Problem ${value}`} />
				{/each}
			</Select.Content>
		</Select.Root>
		<output aria-label="Selected problem">{selected}</output>
	{:else if inlineSelectCase}
		<!-- Labelled trigger with the portal disabled, so the listbox renders inside main. -->
		<Label for="short-select">Short select</Label><Select.Root
			type="single"
			items={shortOptions}
			bind:value={shortSelected}
		>
			<Select.Trigger id="short-select"><Select.Value /></Select.Trigger>
			<Select.Content portalProps={{ disabled: true }}>
				{#each shortOptions as option (option.value)}
					<Select.Item value={option.value} label={option.label}>{option.label}</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
		<output aria-label="Selected short option">{shortSelected}</output>
	{:else}
		<div data-action-region role="group" aria-label="Action region">
			<Button href="#destination" {disabled} onclick={activate}>Run action</Button>
		</div>
		<Button onclick={activate}>Native action</Button>
		<output aria-label="Handler receiver">{receiver}</output>
		<output aria-label="Actions">{actions}</output>
		<output aria-label="Parent actions">{parentActions}</output>
		<button onclick={() => (disabled = !disabled)}>Toggle disabled</button>
		<div id="destination">Destination</div>
	{/if}
</main>
