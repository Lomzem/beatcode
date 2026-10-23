<script lang="ts">
	import { Select as SelectPrimitive } from 'bits-ui';
	import { ChevronDown } from '@lucide/svelte';
	import { cn, type WithoutChild } from '#lib/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		size = 'default',
		...restProps
	}: WithoutChild<SelectPrimitive.TriggerProps> & {
		size?: 'sm' | 'default';
	} = $props();
</script>

<SelectPrimitive.Trigger
	bind:ref
	data-slot="select-trigger"
	data-size={size}
	class={cn(
		'cn-select-trigger flex w-fit items-center justify-between whitespace-normal outline-none disabled:cursor-not-allowed disabled:opacity-50 *:data-[slot=select-value]:flex *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:items-center [&_svg]:pointer-events-none [&_svg]:shrink-0',
		className
	)}
	{...restProps}
>
	{@render children?.()}
	<ChevronDown aria-hidden="true" class="size-4 shrink-0" />
</SelectPrimitive.Trigger>

<style>
	:global([data-slot='select-trigger']) {
		width: 100%;
		min-height: 44px;
		gap: 0.75rem;
		padding: 0.7rem 0.8rem;
		border: 1px solid var(--border);
		border-radius: 0.3rem;
		background: var(--background);
		color: var(--foreground);
		text-align: left;
	}
	:global([data-slot='select-trigger']:focus-visible) {
		outline: 3px solid var(--ring);
		outline-offset: 3px;
	}
	:global([data-slot='select-value']) {
		white-space: normal;
		overflow-wrap: anywhere;
	}
	@media (forced-colors: active) {
		:global([data-slot='select-trigger']:focus-visible) {
			outline-color: Highlight;
		}
	}
</style>
