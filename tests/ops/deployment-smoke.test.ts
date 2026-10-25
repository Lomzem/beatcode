import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';

// Runs the real CLI against a loopback stand-in for the production site.
const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

type Route = { status: number; location?: string };
const page = { status: 200 };

async function smoke(routes: (pathname: string) => Route = () => page) {
	const server = createServer((request, response) => {
		const route = routes(new URL(request.url ?? '/', 'http://localhost').pathname);
		if (route.location) response.writeHead(route.status, { Location: route.location }).end();
		else
			response
				.writeHead(route.status, {
					'Content-Type': 'text/html',
					'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
					'X-Content-Type-Options': 'nosniff'
				})
				.end('<!doctype html>');
	});
	servers.push(server);
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	const { port } = server.address() as AddressInfo;
	return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
		execFile(
			process.execPath,
			['--import', './tests/ops/production-origin.fixture.mjs', 'scripts/ops/deployment-smoke.mjs'],
			{
				env: { PATH: process.env.PATH, SMOKE_FIXTURE_ORIGIN: `http://127.0.0.1:${port}` },
				timeout: 30_000
			},
			(error, stdout, stderr) => done({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr })
		);
	});
}

it('verifies every direct app route, including dynamic and auth-callback routes', async () => {
	const result = await smoke();
	expect(result.code).toBe(0);
	for (const path of ['/', '/privacy', '/sign-in', '/play', '/sso-callback'])
		expect(result.stdout).toContain(`Verified HTTPS app route and headers: ${path}\n`);
	expect(result.stdout).toMatch(/headers: \/room\/[^/\s]+\n/);
	expect(result.stdout).toMatch(/headers: \/match\/[^/\s]+\n/);
});

it('rejects a same-origin redirect that serves a different page', async () => {
	const result = await smoke((pathname) =>
		pathname === '/privacy' ? { status: 302, location: '/' } : page
	);
	expect(result.code).not.toBe(0);
	expect(result.stderr).toContain('Deployment route failed: /privacy (200).');
});

it('rejects a deployment whose dynamic route is not served', async () => {
	const result = await smoke((pathname) =>
		pathname.startsWith('/room/') ? { status: 404 } : page
	);
	expect(result.code).not.toBe(0);
	expect(result.stderr).toMatch(/Deployment route failed: \/room\/[^/\s]+ \(404\)\./);
});
