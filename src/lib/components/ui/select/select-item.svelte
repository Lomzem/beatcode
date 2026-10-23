<script lang="ts">
	import { Select as SelectPrimitive } from 'bits-ui';
	import { Check } from '@lucide/svelte';
	import { cn, type WithoutChild } from '#lib/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		value,
		label,
		children: childrenProp,
		...restProps
	}: WithoutChild<SelectPrimitive.ItemProps> = $props();
</script>

<SelectPrimitive.Item
	bind:ref
	{value}
	{label}
	data-slot="select-item"
	class={cn(
		'cn-select-item relative flex w-full cursor-default items-center outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
		// parity-ignore: Bits marks the active item with data-highlighted; Radix uses :focus, which cn-select-item already styles
		'data-highlighted:bg-accent data-highlighted:text-accent-foreground',
		className
	)}
	{...restProps}
>
	{#snippet children({ selected, highlighted })}
		<span class="cn-select-item-indicator">
			{#if selected}
				<Check aria-hidden="true" class="size-4 shrink-0" />
			{/if}
		</span>
		<!-- parity-ignore: Bits renders the item text inline, so it needs its own box; Radix ItemText carries no classes -->
		<span class="cn-select-item-text min-w-0 whitespace-normal">
			{#if childrenProp}
				{@render childrenProp({ selected, highlighted })}
			{:else}
				{label || value}
			{/if}
		</span>
	{/snippet}
</SelectPrimitive.Item>

<style>
	:global([data-slot='select-item']) {
		min-height: 44px;
		padding: 0.6rem 2rem 0.6rem 0.6rem;
	}
	:global(.cn-select-item-indicator) {
		position: absolute;
		right: 0.5rem;
		display: flex;
		align-items: center;
	}
	:global([data-slot='select-item'][data-highlighted]) {
		background: var(--secondary);
		color: var(--foreground);
		outline: 2px solid var(--ring);
		outline-offset: -2px;
	}
	@media (forced-colors: active) {
		:global([data-slot='select-item'][data-highlighted]) {
			outline-color: Highlight;
		}
	}
</style>
