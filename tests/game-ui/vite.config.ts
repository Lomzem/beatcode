import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	envDir: false,
	publicDir: '../../static',
	plugins: [tailwindcss(), svelte({ configFile: false })],
	resolve: {
		alias: {
			'#lib': fileURLToPath(new URL('../../src/lib', import.meta.url)),
			'convex-svelte': fileURLToPath(new URL('./fake-convex.svelte.ts', import.meta.url)),
			'$app/paths': fileURLToPath(new URL('./paths.ts', import.meta.url)),
			'$app/navigation': fileURLToPath(new URL('./navigation.ts', import.meta.url))
		}
	},
	server: { host: '127.0.0.1', port: 4188, strictPort: true, fs: { allow: ['../..'] } }
});
