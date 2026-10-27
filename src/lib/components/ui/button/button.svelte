<script lang="ts" module>
	import { type VariantProps, tv } from 'tailwind-variants';
	import { cn, type WithElementRef } from '#lib/utils.js';
	import type {
		HTMLAnchorAttributes,
		HTMLButtonAttributes,
		MouseEventHandler
	} from 'svelte/elements';

	export const buttonVariants = tv({
		base: 'cn-button group/button inline-flex max-w-full flex-wrap items-center justify-center transition-[color,background-color,border-color] outline-none select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
		variants: {
			variant: {
				default: 'cn-button-variant-default',
				outline: 'cn-button-variant-outline',
				secondary: 'cn-button-variant-secondary',
				ghost: 'cn-button-variant-ghost',
				destructive: 'cn-button-variant-destructive',
				link: 'cn-button-variant-link'
			},
			size: {
				default: 'cn-button-size-default',
				xs: 'cn-button-size-xs',
				sm: 'cn-button-size-sm',
				lg: 'cn-button-size-lg',
				icon: 'cn-button-size-icon',
				'icon-xs': 'cn-button-size-icon-xs',
				'icon-sm': 'cn-button-size-icon-sm',
				'icon-lg': 'cn-button-size-icon-lg'
			}
		},
		defaultVariants: {
			variant: 'default',
			size: 'default'
		}
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>['variant'];
	export type ButtonSize = VariantProps<typeof buttonVariants>['size'];

	type ButtonStyleProps = {
		variant?: ButtonVariant;
		size?: ButtonSize;
	};

	// A string href renders a link, so its handlers receive anchor events.
	export type ButtonProps = ButtonStyleProps &
		(
			| (WithElementRef<HTMLButtonAttributes> & { href?: undefined })
			| (WithElementRef<HTMLAnchorAttributes> & {
					href: string;
					disabled?: boolean | null;
			  })
		);
</script>

<script lang="ts">
	let {
		class: className,
		variant = 'default',
		size = 'default',
		ref = $bindable(null),
		href = undefined,
		type = 'button',
		disabled,
		children,
		onclick,
		...restProps
	}: ButtonProps = $props();
	// Destructuring loses the href discriminant; each branch restores its alternative.
	type LinkClick = MouseEventHandler<HTMLAnchorElement> | null | undefined;
	type ActionClick = MouseEventHandler<HTMLButtonElement> | null | undefined;
</script>

<!-- Every string href, including '', is a link; an untyped null renders a button like undefined. -->
{#if href != null}
	<!-- The caller resolves internal links; this primitive also accepts external URLs. -->
	<a
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		href={disabled ? undefined : href}
		aria-disabled={disabled}
		role={disabled ? 'link' : undefined}
		tabindex={disabled ? -1 : undefined}
		{...restProps as HTMLAnchorAttributes}
		onclick={(event) => {
			if (disabled) {
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			return (onclick as LinkClick)?.call(event.currentTarget, event);
		}}
	>
		{@render children?.()}
	</a>
{:else}
	<button
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		type={type as HTMLButtonAttributes['type']}
		{disabled}
		onclick={onclick as ActionClick}
		{...restProps as HTMLButtonAttributes}
	>
		{@render children?.()}
	</button>
{/if}
