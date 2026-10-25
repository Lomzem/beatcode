import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import base from '../../vite.config';

// The production app with only the Clerk SDK replaced by a local fake.
export default mergeConfig(base, {
	resolve: {
		alias: {
			'@clerk/clerk-js/no-rhc': fileURLToPath(new URL('./fake-clerk.ts', import.meta.url))
		}
	}
});
