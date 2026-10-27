import type { ComponentProps } from 'svelte';
import Button from '../../src/lib/components/ui/button/button.svelte';

type ButtonProps = ComponentProps<typeof Button>;
type ClickOn<T extends Element> = MouseEvent & { currentTarget: T };
const linkClick = (event: ClickOn<HTMLAnchorElement>) => void event.currentTarget.href;
const actionClick = (event: ClickOn<HTMLButtonElement>) => void event.currentTarget.form;
const link = { href: '#destination', disabled: true, onclick: linkClick } satisfies ButtonProps;
const emptyLink = { href: '', onclick: linkClick } satisfies ButtonProps;
const action = { type: 'submit', onclick: actionClick } satisfies ButtonProps;
// @ts-expect-error Links receive anchor click events, never button events.
const mismatchedLink = { href: '#destination', onclick: actionClick } satisfies ButtonProps;
void [link, emptyLink, action, mismatchedLink];
