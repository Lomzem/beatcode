import { afterEach, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CI_BACKEND_URL } from './deployment';
import {
	openAccountRun,
	createDevAccount,
	cleanupAccountRun,
	recoverAccountRuns
} from './clerk-resources';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});
async function service() {
	const base = await mkdtemp(join(tmpdir(), 'beatcode-clerk-resource-'));
	const directory = await Effect.runPromise(openAccountRun(base));
	const remote = new Map<string, Record<string, unknown>>();
	let failPersistence = false;
	let failList = false;
	let creates = 0;
	let emptyList = false;
	let directStatus = 200;
	let mismatch = false;
	let created: Record<string, unknown> | null = null;
	let intentBeforePost = false;
	let failDelete = false;
	const deleted: string[] = [];
	let arrived!: () => void;
	const post = new Promise<void>((accept) => {
		arrived = accept;
	});
	const old = {
		id: 'user_old_unrelated',
		created_at: 0,
		external_id: 'old-development-user',
		private_metadata: {}
	};
	const server = createServer(async (request, response) => {
		const url = new URL(request.url!, 'http://localhost');
		if (url.pathname.startsWith('/api/')) {
			let body = '';
			for await (const chunk of request) body += chunk;
			const input = JSON.parse(body);
			const args = input.args[0];
			if (
				(input.path === 'recovery:put' && failPersistence) ||
				(input.path === 'recovery:list' && failList)
			) {
				response.writeHead(503).end('{}');
				return;
			}
			let value: unknown = null;
			if (input.path === 'recovery:put') remote.set(args.intent.accountId, args.intent);
			if (input.path === 'recovery:list') value = [...remote.values()];
			if (input.path === 'recovery:remove') remote.delete(args.accountId);
			response.end(JSON.stringify({ status: 'success', value }));
			return;
		}
		if (request.method === 'POST') {
			creates++;

			let body = '';
			for await (const chunk of request) body += chunk;
			const input = JSON.parse(body);
			intentBeforePost =
				(await readdir(directory)).some((name) => name.endsWith('.intent.json')) &&
				remote.has(input.private_metadata.beatcode_ci_account);
			created = {
				...input,
				email_addresses: input.email_address.map((email_address: string) => ({ email_address })),
				id: 'user_new_ci',
				created_at: Date.now()
			};
			arrived();
			// Simulate a committed creation whose response is lost when the worker dies.
			setTimeout(() => {
				if (!response.destroyed) response.end(JSON.stringify(created));
			}, 300);
		} else if (request.method === 'DELETE') {
			if (failDelete) response.writeHead(503).end('{}');
			else {
				deleted.push(url.pathname.split('/').at(-1)!);
				created = null;
				response.end('{"deleted":true}');
			}
		} else if (url.pathname.startsWith('/v1/users/')) {
			if (directStatus !== 200) response.writeHead(directStatus).end('{}');
			else
				response.end(
					JSON.stringify(
						created ? { ...created, ...(mismatch ? { external_id: 'another-account' } : {}) } : null
					)
				);
		} else response.end(JSON.stringify([old, ...(!emptyList && created ? [created] : [])]));
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Test service unavailable');
	const origin = `http://127.0.0.1:${address.port}`;
	const original = globalThis.fetch;
	vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
		const url = new URL(input);
		return original(origin + url.pathname + url.search, init);
	});
	vi.stubEnv('CLERK_CI_SECRET_KEY', 'sk_test_placeholder');
	vi.stubEnv(
		'CONVEX_CI_DEPLOY_KEY',
		`dev:${new URL(CI_BACKEND_URL).hostname.split('.')[0]}|placeholder`
	);
	return {
		directory,
		base,
		remote,
		emptyList: () => {
			emptyList = true;
		},
		directStatus: (value: number) => {
			directStatus = value;
		},
		mismatch: () => {
			mismatch = true;
		},
		creates: () => creates,
		failPersistence: () => {
			failPersistence = true;
		},
		failList: () => {
			failList = true;
		},
		origin,
		post,
		deleted,
		intentBeforePost: () => intentBeforePost,
		failDelete: () => {
			failDelete = true;
		},
		allowDelete: () => {
			failDelete = false;
		},
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((accept) => server.close(() => accept()));
			await rm(base, { recursive: true, force: true });
		}
	};
}

it('a killed creator leaves an intent that reconciles only the exact fresh account after an ambiguous POST', async () => {
	const api = await service();
	const script = `import {Effect} from 'effect'; import {createDevAccount} from './tests/e2e/clerk-resources'; const original=fetch; globalThis.fetch=(input,init)=>{const u=new URL(input); return original(${JSON.stringify(api.origin)}+u.pathname+u.search,init);}; await Effect.runPromise(createDevAccount(${JSON.stringify(api.directory)}));`;
	const child = spawn('bun', ['-e', script], {
		env: {
			...process.env,
			CLERK_CI_SECRET_KEY: 'sk_test_placeholder',
			CONVEX_CI_DEPLOY_KEY: process.env.CONVEX_CI_DEPLOY_KEY
		},
		stdio: 'ignore'
	});
	const closed = once(child, 'close');
	try {
		await api.post;
		child.kill('SIGKILL');
		await closed;
		expect(api.intentBeforePost()).toBe(true);
		await Effect.runPromise(cleanupAccountRun(api.directory));
		expect(api.deleted).toEqual(['user_new_ci']);
		await expect(stat(api.directory)).rejects.toThrow();
	} finally {
		child.kill('SIGKILL');
		await api.close();
	}
}, 10000);

it('failed deletion retains a private noncredential ledger and a later retry cleans only its fresh account', async () => {
	const api = await service();
	try {
		await Effect.runPromise(createDevAccount(api.directory));
		api.failDelete();
		await expect(Effect.runPromise(cleanupAccountRun(api.directory))).rejects.toThrow();
		const names = await readdir(api.directory);
		expect(names.some((name) => name.endsWith('.intent.json'))).toBe(true);
		for (const name of names) {
			expect((await stat(join(api.directory, name))).mode & 0o777).toBe(0o600);
			expect(await readFile(join(api.directory, name), 'utf8')).not.toMatch(
				/Bearer|sk_test|session|testing_token/i
			);
		}
		api.allowDelete();
		await Effect.runPromise(cleanupAccountRun(api.directory));
		expect(api.deleted).toEqual(['user_new_ci']);
	} finally {
		await api.close();
	}
}, 15000);

it('a replacement hosted runner restores failed-delete intent before making new accounts', async () => {
	const api = await service();
	try {
		await Effect.runPromise(createDevAccount(api.directory));
		api.failDelete();
		await expect(Effect.runPromise(cleanupAccountRun(api.directory))).rejects.toThrow();
		expect(api.remote.size).toBe(1);
		await rm(api.base, { recursive: true, force: true }); // Entire old checkout is destroyed.
		api.allowDelete();
		await Effect.runPromise(recoverAccountRuns(api.base));
		expect(api.deleted).toEqual(['user_new_ci']);
		expect(api.remote.size).toBe(0);
		expect(api.creates()).toBe(1);
	} finally {
		await api.close();
	}
}, 15000);
it('unavailable durable persistence or recovery listing fails closed before Clerk creation', async () => {
	const api = await service();
	try {
		api.failPersistence();
		await expect(Effect.runPromise(createDevAccount(api.directory))).rejects.toThrow();
		api.failList();
		await expect(Effect.runPromise(recoverAccountRuns(api.base))).rejects.toThrow();
		expect(api.creates()).toBe(0);
	} finally {
		await api.close();
	}
});

it('known account is directly verified and deleted even when external-ID listing is empty', async () => {
	const api = await service();
	try {
		await Effect.runPromise(createDevAccount(api.directory));
		api.emptyList();
		await Effect.runPromise(cleanupAccountRun(api.directory));
		expect(api.deleted).toEqual(['user_new_ci']);
		expect(api.remote.size).toBe(0);
	} finally {
		await api.close();
	}
});
it.each(['unknown', 'mismatch'])(
	'known-account %s lookup retains recovery without deleting any account',
	async (kind) => {
		const api = await service();
		try {
			await Effect.runPromise(createDevAccount(api.directory));
			api.emptyList();
			if (kind === 'unknown') api.directStatus(503);
			else api.mismatch();
			await expect(Effect.runPromise(cleanupAccountRun(api.directory))).rejects.toThrow();
			expect(api.deleted).toEqual([]);
			expect(api.remote.size).toBe(1);
		} finally {
			await api.close();
		}
	}
);
it('direct known-ID 404 confirms absence and releases recovery', async () => {
	const api = await service();
	try {
		await Effect.runPromise(createDevAccount(api.directory));
		api.emptyList();
		api.directStatus(404);
		await Effect.runPromise(cleanupAccountRun(api.directory));
		expect(api.deleted).toEqual([]);
		expect(api.remote.size).toBe(0);
	} finally {
		await api.close();
	}
});
