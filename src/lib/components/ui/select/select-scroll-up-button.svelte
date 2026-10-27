<script lang="ts">
	import { Select as SelectPrimitive } from 'bits-ui';
	import { ChevronUp } from '@lucide/svelte';
	import { cn, type WithoutChildrenOrChild } from '#lib/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: WithoutChildrenOrChild<SelectPrimitive.ScrollUpButtonProps> = $props();
</script>

<SelectPrimitive.ScrollUpButton
	bind:ref
	data-slot="select-scroll-up-button"
	class={cn('cn-select-scroll-up-button', className)}
	{...restProps}
>
	<ChevronUp aria-hidden="true" class="size-4 shrink-0" />
</SelectPrimitive.ScrollUpButton>

<style>
	:global([data-slot='select-scroll-up-button']) {
		display: flex;
		min-height: 44px;
		align-items: center;
		justify-content: center;
	}
</style>
