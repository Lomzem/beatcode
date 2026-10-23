import { defineEnvVars } from '@sveltejs/kit/env';
export const variables = defineEnvVars({
	PUBLIC_CLERK_PUBLISHABLE_KEY: { public: true, static: true, schema: (value) => value ?? '' },
	PUBLIC_CLERK_OAUTH_PROVIDERS: { public: true, static: true, schema: (value) => value ?? '' },
	PUBLIC_CONVEX_URL: { public: true, static: true, schema: (value) => value ?? '' }
});
