<script lang="ts">
	import { Select as SelectPrimitive } from 'bits-ui';
	import { ChevronDown } from '@lucide/svelte';
	import { cn, type WithoutChildrenOrChild } from '#lib/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: WithoutChildrenOrChild<SelectPrimitive.ScrollDownButtonProps> = $props();
</script>

<SelectPrimitive.ScrollDownButton
	bind:ref
	data-slot="select-scroll-down-button"
	class={cn('cn-select-scroll-down-button', className)}
	{...restProps}
>
	<ChevronDown aria-hidden="true" class="size-4 shrink-0" />
</SelectPrimitive.ScrollDownButton>

<style>
	:global([data-slot='select-scroll-down-button']) {
		display: flex;
		min-height: 44px;
		align-items: center;
		justify-content: center;
	}
</style>
