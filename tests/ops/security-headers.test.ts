import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

// Generates headers with the real script, then serves them through the installed Wrangler's
// local Workers static-assets runtime with the repository's wrangler.jsonc. This is the local
// adapter, not hosted Cloudflare; offline runs cannot observe the production edge.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

const freePort = () =>
	new Promise<number>((done, fail) => {
		const server = createServer().listen(0, '127.0.0.1', () => {
			const { port } = server.address() as { port: number };
			server.close(() => done(port));
		});
		server.on('error', fail);
	});

async function serveGeneratedSite() {
	const dir = await mkdtemp(join(tmpdir(), 'beatcode-headers-'));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, 'build/_app/immutable/entry'), { recursive: true });
	await writeFile(join(dir, 'build/index.html'), '<!doctype html><script>home()</script>');
	await writeFile(join(dir, 'build/200.html'), '<!doctype html><script>route()</script>');
	await writeFile(join(dir, 'build/_app/immutable/entry/app.js'), 'export {};');
	await copyFile('wrangler.jsonc', join(dir, 'wrangler.jsonc'));
	await new Promise<void>((done, fail) =>
		execFile(
			process.execPath,
			[resolve('scripts/ops/security-headers.mjs')],
			{
				cwd: dir,
				env: {
					PATH: process.env.PATH,
					PUBLIC_CONVEX_URL: 'https://careful-greyhound-596.convex.cloud'
				},
				timeout: 30_000
			},
			(error) => (error ? fail(new Error('Header generation failed')) : done())
		)
	);
	const port = await freePort();
	const wrangler: ChildProcess = spawn(
		process.execPath,
		[
			resolve('node_modules/wrangler/bin/wrangler.js'),
			'dev',
			'--config',
			join(dir, 'wrangler.jsonc'),
			'--ip',
			'127.0.0.1',
			'--port',
			String(port),
			'--show-interactive-dev-session=false'
		],
		{
			cwd: dir,
			env: {
				PATH: process.env.PATH,
				HOME: dir,
				WRANGLER_SEND_METRICS: 'false',
				CI: 'true'
			},
			stdio: 'ignore'
		}
	);
	cleanup.push(
		() =>
			new Promise<void>((done) => {
				if (wrangler.exitCode !== null) return done();
				wrangler.once('exit', () => done());
				wrangler.kill('SIGTERM');
			})
	);
	const origin = `http://127.0.0.1:${port}`;
	for (let attempt = 0; ; attempt++) {
		try {
			await fetch(origin);
			return origin;
		} catch {
			if (attempt > 120 || wrangler.exitCode !== null) throw new Error('Wrangler did not start');
			await new Promise((done) => setTimeout(done, 250));
		}
	}
}

it('serves immutable assets with only the immutable cache policy and the shared security headers', async () => {
	const origin = await serveGeneratedSite();
	const fetchHeaders = async (path: string) => {
		const response = await fetch(origin + path, { headers: { Accept: 'text/html' } });
		expect(response.status).toBe(200);
		await response.arrayBuffer();
		return response.headers;
	};
	const asset = await fetchHeaders('/_app/immutable/entry/app.js');
	const home = await fetchHeaders('/');
	const fallback = await fetchHeaders('/room/fixture');

	expect(asset.get('cache-control')).toBe('public, max-age=31536000, immutable');
	expect(home.get('cache-control')).toBe('no-cache');
	expect(fallback.get('cache-control')).toBe('no-cache');
	const policy = home.get('content-security-policy');
	expect(policy).toContain("frame-ancestors 'none'");
	// Clerk's published CSP contract requires Protect's rotating subdomains and
	// non-default HTTPS ports: https://clerk.com/docs/guides/secure/best-practices/csp-headers
	const directives = new Map(
		policy!.split(';').map((directive) => {
			const [name, ...sources] = directive.trim().split(/\s+/);
			return [name, sources];
		})
	);
	for (const directive of ['script-src', 'frame-src']) {
		expect(directives.get(directive)).toContain('https://*.protect.clerk.com');
	}
	expect(directives.get('connect-src')).toContain('https://*.protect.clerk.com:*');
	for (const forbidden of ["'unsafe-inline'", "'unsafe-eval'", '*', 'https:']) {
		expect(directives.get('script-src')).not.toContain(forbidden);
	}
	for (const headers of [asset, fallback]) {
		expect(headers.get('content-security-policy')).toBe(policy);
		expect(headers.get('x-content-type-options')).toBe('nosniff');
		expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
		expect(headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
	}
}, 90_000);
