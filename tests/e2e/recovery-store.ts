import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { CI_BACKEND_URL } from './deployment';

// Internal functions require this dedicated DEV deployment's admin key. No public
// query, artifact upload, credential, browser state or token is stored here.
export async function recoveryCall(name: 'put' | 'list' | 'remove', args: Record<string, unknown>) {
	const key = process.env.CONVEX_CI_DEPLOY_KEY;
	if (!key?.startsWith(`dev:${new URL(CI_BACKEND_URL).hostname.split('.')[0]}|`))
		throw new Error('CI recovery admin credential missing');
	const client = new ConvexHttpClient(CI_BACKEND_URL, {
		logger: false,
		fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) })
	});
	(client as ConvexHttpClient & { setAdminAuth(key: string): void }).setAdminAuth(key);
	return name === 'list'
		? client.query(makeFunctionReference<'query'>('recovery:list'), args)
		: client.mutation(makeFunctionReference<'mutation'>(`recovery:${name}`), args);
}
