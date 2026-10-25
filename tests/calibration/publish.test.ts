import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// The publisher pins the operator's private checkout. These fixtures redirect only that
// namespace into a temporary tree with real directories and symlinks, so the real private
// checkout is never read. GitHub and the DEV deployment are offline fakes.
const { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } =
	await vi.importActual<typeof import('node:fs')>('node:fs');
const checkout = '/home/lomzem/proj/beatcode-problems';
const state = vi.hoisted(() => ({
	base: '',
	gh: [] as string[][],
	packageReads: [] as string[],
	requests: [] as { url: string; name?: string }[]
}));
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
			const { path } = JSON.parse(String(init.body));
			state.requests.push({ url: String(url), name: path });
			const value = {
				'problems:_registerEnvironment': { judgeEnvId: 'environment' },
				'problems:_uploadUrl': { uploadUrl: 'https://upload.invalid/fixture' },
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
