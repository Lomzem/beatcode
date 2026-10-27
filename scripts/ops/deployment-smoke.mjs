import { Data, Effect } from 'effect';

class DeploymentCheckError extends Data.TaggedError('DeploymentCheckError') {}

// Public pages plus SPA-fallback routes, visited directly with inert IDs.
const paths = [
	'/',
	'/privacy',
	'/sign-in',
	'/play',
	'/room/deployment-smoke',
	'/match/deployment-smoke',
	'/sso-callback'
];

const smoke = Effect.gen(function* () {
	const site = yield* Effect.try({
		try: () => new URL(process.env.BEATCODE_SITE_URL ?? 'https://beatcode.org'),
		catch: () => new DeploymentCheckError({ message: 'Invalid deployment origin.' })
	});
	if (site.origin !== 'https://beatcode.org')
		return yield* new DeploymentCheckError({ message: 'Unexpected deployment origin.' });
	for (const path of paths) {
		const requested = new URL(path, site);
		const response = yield* Effect.tryPromise({
			try: () => fetch(requested, { signal: AbortSignal.timeout(15_000), redirect: 'follow' }),
			catch: () => new DeploymentCheckError({ message: `Deployment route unavailable: ${path}.` })
		});
		// A redirect elsewhere on the site would otherwise verify the wrong page.
		const served = new URL(response.url);
		if (
			response.status !== 200 ||
			served.origin !== site.origin ||
			served.pathname !== requested.pathname ||
			!response.headers.get('content-type')?.includes('text/html')
		)
			return yield* new DeploymentCheckError({
				message: `Deployment route failed: ${path} (${response.status}).`
			});
		if (
			!response.headers.get('content-security-policy')?.includes("frame-ancestors 'none'") ||
			response.headers.get('x-content-type-options') !== 'nosniff'
		)
			return yield* new DeploymentCheckError({
				message: `Deployment security headers missing: ${path}.`
			});
		console.log(`Verified HTTPS app route and headers: ${path}`);
	}
});

await Effect.runPromise(smoke);
