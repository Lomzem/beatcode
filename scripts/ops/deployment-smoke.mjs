import { Data, Effect } from 'effect';

class DeploymentCheckError extends Data.TaggedError('DeploymentCheckError') {}

const smoke = Effect.gen(function* () {
	const site = yield* Effect.try({
		try: () => new URL(process.env.BEATCODE_SITE_URL ?? 'https://beatcode.org'),
		catch: () => new DeploymentCheckError({ message: 'Invalid deployment origin.' })
	});
	if (site.origin !== 'https://beatcode.org')
		return yield* new DeploymentCheckError({ message: 'Unexpected deployment origin.' });
	for (const path of ['/', '/privacy', '/sign-in', '/play']) {
		const response = yield* Effect.tryPromise({
			try: () =>
				fetch(new URL(path, site), { signal: AbortSignal.timeout(15_000), redirect: 'follow' }),
			catch: () => new DeploymentCheckError({ message: `Deployment route unavailable: ${path}.` })
		});
		if (
			response.status !== 200 ||
			new URL(response.url).origin !== site.origin ||
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
