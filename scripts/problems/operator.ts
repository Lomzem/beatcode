import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { ConvexHttpClient } from 'convex/browser';
import { Data, Effect } from 'effect';
import { DEV_CALIBRATION } from '../../shared/calibrationDeployment.ts';

const envFile = resolve('.scratch/competitive-leetcode/convex.dev.env');

class DevOperatorError extends Data.TaggedError('DevOperatorError')<{
	readonly message: string;
}> {}

type AdminClient = {
	setAdminAuth(token: string): void;
	clearAuth(): void;
	setFetchOptions(options: RequestInit): void;
	function(name: string, componentPath: undefined, args: unknown): Promise<unknown>;
};

const fail = (message: string) => () => new DevOperatorError({ message });

/**
 * Convex 1.48's installed HTTP client implements internal admin auth and the `convex run`
 * any-kind endpoint; only its public .d.ts strips them. Arguments travel in the request body,
 * never argv, so hidden package payloads stay out of the process list and argument limits.
 */
const devClient = Effect.acquireRelease(
	Effect.gen(function* () {
		const configuration = yield* Effect.try({
			try: () => readFileSync(envFile, 'utf8'),
			catch: fail('DEV_DEPLOYMENT_REQUIRED')
		});
		if (
			!/^CONVEX_DEPLOYMENT=['"]?dev:descriptive-scorpion-877\b/m.test(configuration) ||
			(process.env.CONVEX_DEPLOYMENT &&
				process.env.CONVEX_DEPLOYMENT !== DEV_CALIBRATION.deployment) ||
			(process.env.PUBLIC_CONVEX_URL && process.env.PUBLIC_CONVEX_URL !== DEV_CALIBRATION.url) ||
			(process.env.CONVEX_CLOUD_URL && process.env.CONVEX_CLOUD_URL !== DEV_CALIBRATION.url)
		)
			return yield* new DevOperatorError({ message: 'DEV_DEPLOYMENT_REQUIRED' });
		const key = process.env.CONVEX_DEV_DEPLOY_KEY;
		if (
			!key ||
			!/^dev:descriptive-scorpion-877\|[^\s|]+$/.test(key) ||
			[
				'CONVEX_DEPLOY_KEY',
				'CONVEX_DEPLOYMENT_TOKEN',
				'CONVEX_SELF_HOSTED_URL',
				'CONVEX_SELF_HOSTED_ADMIN_KEY'
			].some((name) => process.env[name])
		)
			return yield* new DevOperatorError({ message: 'DEV_AUTH_REQUIRED' });
		const decode = { invalid: false };
		const client = yield* Effect.try({
			try: () =>
				new ConvexHttpClient(DEV_CALIBRATION.url, {
					logger: false,
					fetch: async (input, options) => {
						const response = await fetch(input, {
							...options,
							// Interrupting the Effect aborts the request; the deadline still applies.
							signal: options?.signal
								? AbortSignal.any([options.signal, AbortSignal.timeout(610000)])
								: AbortSignal.timeout(610000)
						});
						if (response.ok) {
							const body = await response
								.clone()
								.json()
								.catch(() => undefined);
							decode.invalid = body?.status !== 'success' && body?.status !== 'error';
						}
						return response;
					}
				}) as unknown as AdminClient,
			catch: fail('DEV_AUTH_REQUIRED')
		});
		if (
			typeof client.setAdminAuth !== 'function' ||
			typeof client.setFetchOptions !== 'function' ||
			typeof client.function !== 'function'
		)
			return yield* new DevOperatorError({ message: 'DEV_AUTH_REQUIRED' });
		client.setAdminAuth(key);
		return { client, decode };
	}),
	({ client }) => Effect.sync(() => client.clearAuth())
);

export function devCall<T = unknown>(name: string, args: unknown) {
	return Effect.scoped(
		Effect.gen(function* () {
			const { client, decode } = yield* devClient;
			const result = yield* Effect.tryPromise({
				try: (signal) => {
					client.setFetchOptions({ signal });
					return client.function(name, undefined, args);
				},
				// SDK exceptions may echo hidden source, server messages and credentials.
				catch: () =>
					new DevOperatorError({
						message: decode.invalid
							? `DEV_OPERATOR_OUTPUT_INVALID:${name}`
							: `DEV_OPERATOR_CALL_FAILED:${name}`
					})
			});
			// Void functions return null on the wire; `convex run` previously reported no result.
			return (result ?? undefined) as T;
		})
	);
}
