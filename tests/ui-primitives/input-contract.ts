import type { ComponentProps } from 'svelte';
import Input from '../../src/lib/components/ui/input/input.svelte';

type InputProps = ComponentProps<typeof Input>;
const upload = { type: 'file', multiple: true } satisfies InputProps;
const text = { type: 'text', value: 'Description' } satisfies InputProps;
// @ts-expect-error File inputs accept files, never a value default.
const invalidUpload = { type: 'file', value: 'solution.cpp' } satisfies InputProps;
void [upload, text, invalidUpload];
