import { ConvexHttpClient } from 'convex/browser';
import type { FunctionReference, DefaultFunctionArgs } from 'convex/server';
import { Effect } from 'effect';
import { PROD_CALIBRATION } from '../../shared/calibrationDeployment.ts';
import { OperatorError, operatorAsync, operatorSync } from './effects.ts';

type AdminClient = {
	setAdminAuth(token: string): void;
	clearAuth(): void;
	query<A extends DefaultFunctionArgs, R>(
		ref: FunctionReference<'query', 'internal', A, R>,
		args: A
	): Promise<R>;
	mutation<A extends DefaultFunctionArgs, R>(
		ref: FunctionReference<'mutation', 'internal', A, R>,
		args: A
	): Promise<R>;
	action<A extends DefaultFunctionArgs, R>(
		ref: FunctionReference<'action', 'internal', A, R>,
		args: A
	): Promise<R>;
};

/** Convex 1.48's installed HTTP client implements internal admin auth; only its public .d.ts strips it. */
export function productionTransport() {
	return Effect.acquireRelease(
		operatorSync('PRODUCTION_AUTH_REQUIRED', () => {
			const key = process.env.CONVEX_PRODUCTION_DEPLOY_KEY;
			if (!key || !/^prod:careful-greyhound-596\|[^\s|]+$/.test(key)) throw new Error();
			for (const name of [
				'CONVEX_DEPLOY_KEY',
				'CONVEX_DEPLOYMENT_TOKEN',
				'CONVEX_SELF_HOSTED_URL',
				'CONVEX_SELF_HOSTED_ADMIN_KEY'
			]) {
				if (process.env[name]) throw new Error();
			}
			if (
				(process.env.CONVEX_DEPLOYMENT &&
					process.env.CONVEX_DEPLOYMENT !== PROD_CALIBRATION.deployment) ||
				(process.env.PUBLIC_CONVEX_URL && process.env.PUBLIC_CONVEX_URL !== PROD_CALIBRATION.url) ||
				(process.env.CONVEX_CLOUD_URL && process.env.CONVEX_CLOUD_URL !== PROD_CALIBRATION.url)
			)
				throw new Error();
			const client = new ConvexHttpClient(PROD_CALIBRATION.url, {
				logger: false,
				fetch: (input, options) => fetch(input, { ...options, signal: AbortSignal.timeout(610000) })
			}) as unknown as AdminClient;
			if (typeof client.setAdminAuth !== 'function') throw new Error();
			client.setAdminAuth(key);
			return {
				query: <A extends DefaultFunctionArgs, R>(
					ref: FunctionReference<'query', 'internal', A, R>,
					args: A
				) => operatorAsync('PRODUCTION_QUERY_FAILED', () => client.query(ref, args)),
				mutation: <A extends DefaultFunctionArgs, R>(
					ref: FunctionReference<'mutation', 'internal', A, R>,
					args: A
				) => operatorAsync('PRODUCTION_MUTATION_FAILED', () => client.mutation(ref, args)),
				action: <A extends DefaultFunctionArgs, R>(
					ref: FunctionReference<'action', 'internal', A, R>,
					args: A
				) => operatorAsync('PRODUCTION_ACTION_FAILED', () => client.action(ref, args)),
				close: () => client.clearAuth()
			};
		}),
		(client) =>
			operatorSync('PRODUCTION_CLIENT_CLOSE_FAILED', client.close).pipe(
				Effect.orElseSucceed(() => undefined)
			)
	).pipe(Effect.mapError(() => new OperatorError({ message: 'PRODUCTION_AUTH_REQUIRED' })));
}
