<script lang="ts">
	import { cn, type WithElementRef } from '#lib/utils.js';
	import type { HTMLInputAttributes, HTMLInputTypeAttribute } from 'svelte/elements';

	// Svelte includes an open string member; remove it so 'file' cannot bypass the union.
	type InputType<T = HTMLInputTypeAttribute> = T extends string
		? string extends T
			? never
			: Exclude<T, 'file' | 'checkbox'>
		: never;

	type Props = WithElementRef<
		Omit<HTMLInputAttributes, 'type' | 'value' | 'checked'> &
			(
				| { type: 'file'; files?: FileList; value?: never; checked?: never }
				// Checkboxes bind checked state; value is only the submitted form value.
				| {
						type: 'checkbox';
						files?: undefined;
						value?: HTMLInputAttributes['value'];
						checked?: boolean;
				  }
				| {
						type?: InputType;
						files?: undefined;
						value?: HTMLInputAttributes['value'];
						checked?: HTMLInputAttributes['checked'];
				  }
			)
	>;

	let {
		ref = $bindable(null),
		value = $bindable(),
		type,
		files = $bindable(),
		checked = $bindable(),
		class: className,
		'data-slot': dataSlot = 'input',
		...restProps
	}: Props = $props();
</script>

{#if type === 'file'}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(
			'cn-input w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
			className
		)}
		type="file"
		bind:files
		{...restProps}
	/>
{:else if type === 'checkbox'}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(
			'cn-input w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
			className
		)}
		type="checkbox"
		{value}
		bind:checked
		{...restProps}
	/>
{:else}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(
			'cn-input w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
			className
		)}
		{type}
		bind:value
		{checked}
		{...restProps}
	/>
{/if}
