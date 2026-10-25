<script lang="ts">
	import { onMount } from 'svelte';
	import { Effect } from 'effect';
	import { storage, optionalStorage } from '#lib/auth/storage.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	const options = {
		theme: [
			{
				value: 'system',
				label: 'Use device setting'
			},
			{
				value: 'dark',
				label: 'Dark'
			},
			{
				value: 'light',
				label: 'Light'
			},
			{
				value: 'contrast',
				label: 'High contrast'
			}
		],
		motion: [
			{
				value: 'system',
				label: 'Use device setting'
			},
			{
				value: 'reduce',
				label: 'Reduce motion'
			}
		],
		wrap: [
			{
				value: 'on',
				label: 'On'
			},
			{
				value: 'off',
				label: 'Off (scroll within the editor)'
			}
		],
		font: [
			{
				value: '1',
				label: 'Standard'
			},
			{
				value: '1.25',
				label: 'Large'
			},
			{
				value: '1.5',
				label: 'Extra large'
			}
		],
		announcements: [
			{
				value: 'standard',
				label: 'Results, effects and timer milestones'
			},
			{
				value: 'affordable',
				label: 'Also announce affordable cards'
			}
		]
	};
	let theme = $state('system');
	let motion = $state('system');
	let message = $state('');
	let wrap = $state('on');
	let font = $state('1');
	let announcements = $state('standard');
	onMount(() => {
		Effect.runSync(
			optionalStorage(() => {
				wrap = localStorage.getItem('beatcode.wrap') === 'off' ? 'off' : 'on';
				font = localStorage.getItem('beatcode.font') ?? '1';
				announcements = localStorage.getItem('beatcode.announcements') ?? 'standard';
				const savedTheme = localStorage.getItem('beatcode.theme');
				theme =
					savedTheme && ['system', 'light', 'dark', 'contrast'].includes(savedTheme)
						? savedTheme
						: 'system';
				motion = localStorage.getItem('beatcode.motion') === 'reduce' ? 'reduce' : 'system';
			}, undefined)
		);
	});
	// Name each change so repeated saves still update the status region.
	function save(setting: string, items: { value: string; label: string }[], value: string) {
		const change = `${setting}: ${items.find((item) => item.value === value)?.label}.`;
		Effect.runSync(
			Effect.gen(function* () {
				if (theme === 'system') delete document.documentElement.dataset.theme;
				else document.documentElement.dataset.theme = theme;
				if (motion === 'system') delete document.documentElement.dataset.motion;
				else document.documentElement.dataset.motion = motion;
				yield* storage(() => {
					localStorage.setItem('beatcode.wrap', wrap);
					localStorage.setItem('beatcode.font', font);
					localStorage.setItem('beatcode.announcements', announcements);
					localStorage.setItem('beatcode.theme', theme);
					localStorage.setItem('beatcode.motion', motion);
				});
				message = `${change} Saved on this device.`;
			}).pipe(
				Effect.catchTag('StorageUnavailable', () =>
					Effect.sync(() => {
						message = `${change} Applied for now. Your browser could not save preferences on this device.`;
					})
				)
			)
		);
	}
</script>

<svelte:head><title>Settings — Beatcode</title></svelte:head>
<div class="shell page prose">
	<h1>Settings</h1>
	<section class="panel" aria-labelledby="display-heading">
		<h2 id="display-heading">Display</h2>
		<div class="field">
			<Label for="theme">Appearance</Label><Select.Root
				type="single"
				name="theme"
				items={options.theme}
				bind:value={theme}
				onValueChange={(value) => {
					theme = value;
					save('Appearance', options.theme, value);
				}}
			>
				<Select.Trigger id="theme" aria-describedby="theme-help"><Select.Value /></Select.Trigger>
				<Select.Content portalProps={{ disabled: true }}>
					{#each options.theme as option (option.value)}
						<Select.Item value={option.value} label={option.label}>{option.label}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			<p id="theme-help" class="muted">
				High contrast remains available when a Light mode card is played.
			</p>
		</div>
		<div class="field">
			<Label for="motion">Motion</Label><Select.Root
				type="single"
				name="motion"
				items={options.motion}
				bind:value={motion}
				onValueChange={(value) => {
					motion = value;
					save('Motion', options.motion, value);
				}}
			>
				<Select.Trigger id="motion" aria-describedby="motion-help"><Select.Value /></Select.Trigger>
				<Select.Content portalProps={{ disabled: true }}>
					{#each options.motion as option (option.value)}
						<Select.Item value={option.value} label={option.label}>{option.label}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			<p id="motion-help" class="muted">
				Your device’s reduced-motion preference is always respected.
			</p>
		</div>
		<div class="field">
			<Label for="wrap">Editor line wrapping</Label><Select.Root
				type="single"
				name="wrap"
				items={options.wrap}
				bind:value={wrap}
				onValueChange={(value) => {
					wrap = value;
					save('Editor line wrapping', options.wrap, value);
				}}
			>
				<Select.Trigger id="wrap"><Select.Value /></Select.Trigger>
				<Select.Content portalProps={{ disabled: true }}>
					{#each options.wrap as option (option.value)}
						<Select.Item value={option.value} label={option.label}>{option.label}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
		<div class="field">
			<Label for="font">Editor font size</Label><Select.Root
				type="single"
				name="font"
				items={options.font}
				bind:value={font}
				onValueChange={(value) => {
					font = value;
					save('Editor font size', options.font, value);
				}}
			>
				<Select.Trigger id="font"><Select.Value /></Select.Trigger>
				<Select.Content portalProps={{ disabled: true }}>
					{#each options.font as option (option.value)}
						<Select.Item value={option.value} label={option.label}>{option.label}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
		<div class="field">
			<Label for="announcements">Game announcements</Label><Select.Root
				type="single"
				name="announcements"
				items={options.announcements}
				bind:value={announcements}
				onValueChange={(value) => {
					announcements = value;
					save('Game announcements', options.announcements, value);
				}}
			>
				<Select.Trigger id="announcements"><Select.Value /></Select.Trigger>
				<Select.Content portalProps={{ disabled: true }}>
					{#each options.announcements as option (option.value)}
						<Select.Item value={option.value} label={option.label}>{option.label}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
		<p role="status" aria-live="polite">{message}</p>
	</section>
</div>

<style>
	h2 {
		margin-top: 0 !important;
	}
	.field p {
		font-size: 0.85rem;
		margin: 0;
	}
	[role='status'] {
		margin-bottom: 0;
		font-size: 0.85rem;
	}
</style>
