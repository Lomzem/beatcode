import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// The publisher pins the operator's private checkout. These fixtures redirect only that
// namespace into a temporary tree with real directories and symlinks, so the real private
// checkout is never read. GitHub and the DEV deployment are offline fakes; a loopback server
// stands in for the upload URL the DEV deployment issues, reached through the real fetch.
const { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } =
	await vi.importActual<typeof import('node:fs')>('node:fs');
const checkout = '/home/lomzem/proj/beatcode-problems';
const state = vi.hoisted(() => ({
	base: '',
	gh: [] as string[][],
	packageReads: [] as string[],
	requests: [] as { url: string; name?: string }[],
	uploadUrl: ''
}));
const send = globalThis.fetch;
const toFixture = (path: string) =>
	path === checkout || path.startsWith(`${checkout}/`)
		? state.base + path.slice(checkout.length)
		: path;
const fromFixture = (path: string) =>
	path === state.base || path.startsWith(`${state.base}/`)
		? checkout + path.slice(state.base.length)
		: path;

vi.mock('node:child_process', () => ({
	execFileSync: vi.fn((file: string, args: string[]) => {
		state.gh.push([file, ...args]);
		return JSON.stringify({ isPrivate: true, visibility: 'PRIVATE' });
	})
}));
vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>();
	return {
		...actual,
		existsSync: (path: string) => actual.existsSync(toFixture(path)),
		lstatSync: (path: string) => actual.lstatSync(toFixture(path)),
		realpathSync: (path: string) => fromFixture(actual.realpathSync(toFixture(path))),
		readFileSync: (path: string, options?: BufferEncoding) =>
			path.endsWith('.scratch/competitive-leetcode/convex.dev.env')
				? 'CONVEX_DEPLOYMENT=dev:descriptive-scorpion-877\n'
				: actual.readFileSync(toFixture(path), options)
	};
});
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	const read =
		<A extends unknown[], R>(run: (path: string, ...rest: A) => Promise<R>) =>
		(path: string, ...rest: A) => {
			state.packageReads.push(path);
			return run(toFixture(path), ...rest);
		};
	return {
		...actual,
		lstat: read(actual.lstat),
		readdir: read(actual.readdir as (path: string) => Promise<string[]>),
		readFile: read(actual.readFile as (path: string) => Promise<Buffer>)
	};
});

function writePackage(dir: string, slug: string) {
	const files: Record<string, string> = {
		'problem.yaml': JSON.stringify({
			format: 'beatcode-problem/1',
			license: 'original',
			checker: 'tokens',
			author: 'fixture',
			title: 'Fixture',
			slug,
			difficulty: 1,
			version: 1,
			calibration: { repeats: 8, ac_multiplier: 2.5, tle_multiplier: 2.5 },
			limits: { memory_mib: 256, output_kib: 64, aggregate_ms: 1000 }
		}),
		'statement.md': 'statement',
		'data/sample/01.in': '1\n',
		'data/sample/01.ans': '1\n',
		'submissions/accepted/a.cpp': 'int main() {}',
		'submissions/time_limit_exceeded/t.cpp': 'int main() { for (;;); }',
		'submissions/wrong_answer/w.cpp': 'int main() { return 1; }',
		'validator/validate.cpp': 'int main() {}',
		'generators/gen.cpp': 'int main() {}'
	};
	for (let i = 1; i <= 10; i++) {
		files[`data/secret/${i}.in`] = `${i}\n`;
		files[`data/secret/${i}.ans`] = `${i}\n`;
	}
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), text);
	}
}

let root: string;
let argv: string[];
beforeEach(() => {
	vi.resetModules();
	argv = process.argv;
	root = realpathSync(mkdtempSync(join(tmpdir(), 'beatcode-publish-')));
	state.base = join(root, 'beatcode-problems');
	state.gh = [];
	state.packageReads = [];
	state.requests = [];
	state.uploadUrl = 'https://upload.invalid/fixture';
	for (const name of [
		'CONVEX_DEPLOY_KEY',
		'CONVEX_DEPLOYMENT_TOKEN',
		'CONVEX_SELF_HOSTED_URL',
		'CONVEX_SELF_HOSTED_ADMIN_KEY',
		'CONVEX_DEPLOYMENT',
		'CONVEX_CLOUD_URL',
		'PUBLIC_CONVEX_URL'
	])
		vi.stubEnv(name, undefined);
	vi.stubEnv('CONVEX_DEV_DEPLOY_KEY', 'dev:descriptive-scorpion-877|fixture-not-a-credential');
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit) => {
			if (String(url) === 'https://upload.invalid/fixture') {
				state.requests.push({ url: String(url) });
				return Response.json({ storageId: 'storage' });
			}
			if (String(url).startsWith('http://127.0.0.1:')) {
				state.requests.push({ url: 'loopback upload' });
				return send(url, init);
			}
			const { path } = JSON.parse(String(init.body));
			state.requests.push({ url: String(url), name: path });
			const value = {
				'problems:_registerEnvironment': { judgeEnvId: 'environment' },
				'problems:_uploadUrl': { uploadUrl: state.uploadUrl },
				'problems:_createVersion': { problemVersionId: 'version' }
			}[path as string];
			return Response.json({ status: 'success', value, logLines: [] });
		})
	);
});
afterEach(() => {
	process.argv = argv;
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(root, { recursive: true, force: true });
});

const publish = (slug: string) => {
	process.argv = ['node', 'publish.ts', `${checkout}/${slug}`];
	return import('../../scripts/problems/publish');
};

it('publishes a canonical private-checkout package to the DEV draft endpoints', async () => {
	writePackage(join(state.base, 'fixture-sum'), 'fixture-sum');
	const output = vi.spyOn(console, 'log').mockImplementation(() => {});
	try {
		await publish('fixture-sum');
		expect(output).toHaveBeenCalledWith(
			JSON.stringify({ slug: 'fixture-sum', problemVersionId: 'version' })
		);
	} finally {
		output.mockRestore();
	}
	expect(state.gh).toEqual([
		['gh', 'repo', 'view', 'Lomzem/beatcode-problems', '--json', 'isPrivate,visibility']
	]);
	expect(state.requests.map((r) => r.name ?? r.url)).toEqual([
		'problems:_registerEnvironment',
		'problems:_uploadUrl',
		'https://upload.invalid/fixture',
		'problems:_createVersion'
	]);
});

it.each([
	[
		'slug directory',
		() => {
			writePackage(join(root, 'outside/fixture-sum'), 'fixture-sum');
			mkdirSync(state.base);
			symlinkSync(join(root, 'outside/fixture-sum'), join(state.base, 'fixture-sum'));
		}
	],
	[
		'private checkout root',
		() => {
			writePackage(join(root, 'outside/fixture-sum'), 'fixture-sum');
			symlinkSync(join(root, 'outside'), state.base);
		}
	]
])('rejects a symlinked %s before privacy, package reads or upload', async (_, arrange) => {
	arrange();
	await expect(publish('fixture-sum')).rejects.toThrow('PRIVATE_REPOSITORY_REQUIRED');
	expect(state.gh).toEqual([]);
	expect(state.packageReads).toEqual([]);
	expect(state.requests).toEqual([]);
});

async function uploadServer(handle: (request: IncomingMessage, response: ServerResponse) => void) {
	const server = createServer(handle);
	// A missing deadline leaves the upload pending past the Vitest timeout, which does not cancel
	// the test body; release the connection however the test ends.
	onTestFinished(
		() =>
			new Promise<void>((done) => {
				server.closeAllConnections();
				server.close(() => done());
			})
	);
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	state.uploadUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload`;
	return server;
}

it('refuses an upload redirect instead of following it to another storage endpoint', async () => {
	writePackage(join(state.base, 'fixture-sum'), 'fixture-sum');
	const paths: string[] = [];
	await uploadServer((request, response) => {
		paths.push(request.url ?? '');
		request.resume();
		if (request.url === '/upload') response.writeHead(307, { Location: '/elsewhere' }).end();
		else response.writeHead(200).end(JSON.stringify({ storageId: 'redirected' }));
	});
	await expect(publish('fixture-sum')).rejects.toThrow('UPLOAD_FAILED');
	expect(paths).toEqual(['/upload']);
	expect(state.requests.map((r) => r.name ?? r.url)).toEqual([
		'problems:_registerEnvironment',
		'problems:_uploadUrl',
		'loopback upload'
	]);
});

it.each([
	['response headers', 'UPLOAD_FAILED', () => {}],
	[
		'response body',
		'UPLOAD_RESPONSE_INVALID',
		(response: ServerResponse) =>
			response.writeHead(200, { 'Content-Type': 'application/json' }).write('{"storageId":')
	]
])('abandons an upload whose %s stall at the 30-second deadline', async (_, message, stall) => {
	writePackage(join(state.base, 'fixture-sum'), 'fixture-sum');
	// Node's AbortSignal.timeout runs on internal timers that fake timers cannot advance, so the
	// native timer runs 1000x faster. Real clock accuracy is not under test.
	const scale = 1000;
	const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
	let armed = 0;
	const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
		armed = performance.now();
		return nativeTimeout(ms / scale);
	});
	onTestFinished(() => timeout.mockRestore());
	let abandoned: (waited: number) => void = () => {};
	const closed = new Promise<number>((done) => (abandoned = done));
	await uploadServer((request, response) => {
		request.resume();
		response.on('close', () => abandoned((performance.now() - armed) * scale));
		stall(response);
	});
	await expect(publish('fixture-sum')).rejects.toThrow(message);
	const waited = await closed;
	// Production DEV calls may run for 10 minutes; the upload alone has a 30-second bound.
	expect(waited).toBeGreaterThanOrEqual(30_000);
	expect(waited).toBeLessThan(300_000);
	expect(state.requests.map((r) => r.name ?? r.url)).not.toContain('problems:_createVersion');
});

it.each([
	['null', 'null'],
	['an object without a storage ID', '{}'],
	['a non-string storage ID', '{"storageId":42}'],
	['an empty storage ID', '{"storageId":""}']
])('rejects an upload response of %s before creating a version', async (_, body) => {
	writePackage(join(state.base, 'fixture-sum'), 'fixture-sum');
	await uploadServer((request, response) => {
		request.resume();
		response.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
	});
	await expect(publish('fixture-sum')).rejects.toThrow('UPLOAD_RESPONSE_INVALID');
	expect(state.requests.map((r) => r.name ?? r.url)).toEqual([
		'problems:_registerEnvironment',
		'problems:_uploadUrl',
		'loopback upload'
	]);
});
