import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import ts from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import { plugin as shadcn } from '@shadcn/lint';
export default ts.config(
	{
		ignores: [
			'.svelte-kit/**',
			'build/**',
			'node_modules/**',
			'convex/_generated/**',
			'.scratch/**',
			'playwright-report/**',
			'test-results/**'
		]
	},
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	{ languageOptions: { globals: { ...globals.browser, ...globals.node } } },
	{
		files: ['**/*.svelte', '**/*.svelte.ts'],
		languageOptions: { parserOptions: { parser: ts.parser } }
	},
	{
		files: ['**/*.svelte', '**/*.ts'],
		plugins: { shadcn },
		rules: { 'shadcn/no-restyle': ['error', { allow: ['layout'] }] }
	},
	// Generic link primitive forwards caller-resolved internal routes and external URLs.
	{
		files: ['src/lib/components/ui/button/button.svelte'],
		rules: { 'svelte/no-navigation-without-resolve': 'off' }
	},
	prettier,
	...svelte.configs.prettier
);
