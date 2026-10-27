import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

// Runs the real CLI against a loopback stand-in for the Cloudflare API.
const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

type Manifest = { zone: string; records: { name: string; content: string; ttl: number }[] };
const manifest: Manifest = JSON.parse(readFileSync('ops/dns.json', 'utf8'));
const account = 'fixture-account';
type Existing = {
	id: string;
	type: string;
	content: string;
	proxied: boolean;
	ttl: number;
	comment?: string;
};
type Write = { method: string; path: string; body: Record<string, unknown> };

async function sync(
	records: Manifest['records'],
	options: { apply?: boolean; existing?: Record<string, Existing> } = {}
) {
	const requests: string[] = [];
	const writes: Write[] = [];
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? '/', 'http://localhost');
		requests.push(`${request.method} ${url.pathname}`);
		let body = '';
		request.on('data', (chunk) => (body += chunk));
		request.on('end', () => {
			let result: unknown = {};
			if (url.pathname === '/client/v4/zones')
				result = [{ id: 'zone', account: { id: account }, status: 'active' }];
			else if (request.method === 'GET') {
				// Cloudflare's list filter is the `name` object; `name.exact` is its exact match.
				// Any other query shape is refused, so a misnamed filter cannot pass as "no records".
				const filter = [...url.searchParams];
				if (filter.length !== 1 || filter[0][0] !== 'name.exact') {
					response
						.writeHead(400, { 'Content-Type': 'application/json' })
						.end(JSON.stringify({ success: false, errors: [{ code: 9999 }], result: null }));
					return;
				}
				const current = options.existing?.[filter[0][1]];
				result = current ? [current] : [];
			} else
				writes.push({ method: request.method ?? '', path: url.pathname, body: JSON.parse(body) });
			response
				.writeHead(200, { 'Content-Type': 'application/json' })
				.end(JSON.stringify({ success: true, result }));
		});
	});
	servers.push(server);
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	const { port } = server.address() as AddressInfo;
	const directory = await mkdtemp(join(tmpdir(), 'dns-sync-'));
	directories.push(directory);
	const path = join(directory, 'dns.json');
	await writeFile(path, JSON.stringify({ ...manifest, records }));
	const result = await new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
		execFile(
			process.execPath,
			[
				'--import',
				'./tests/ops/cloudflare-api.fixture.mjs',
				'scripts/ops/dns-sync.mjs',
				path,
				...(options.apply ? ['--apply'] : [])
			],
			{
				env: {
					PATH: process.env.PATH,
					CLOUDFLARE_FIXTURE_ORIGIN: `http://127.0.0.1:${port}`,
					CLOUDFLARE_API_TOKEN: 'fixture-token',
					CLOUDFLARE_ACCOUNT_ID: account
				},
				timeout: 30_000
			},
			(error, stdout, stderr) => done({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr })
		);
	});
	return { ...result, requests, writes };
}

function existing(name: string, change: Partial<Existing> = {}): Record<string, Existing> {
	const record = manifest.records.find((candidate) => candidate.name === name)!;
	return {
		[name]: {
			id: 'current',
			type: 'CNAME',
			content: record.content,
			proxied: false,
			ttl: record.ttl,
			comment: 'beatcode-managed',
			...change
		}
	};
}

it('validates the complete committed manifest in a dry run', async () => {
	const result = await sync(manifest.records);
	expect(result.code).toBe(0);
	expect(result.stdout).toBe('Validated 5 DNS-only Clerk CNAME records for beatcode.org.\n');
	expect(result.requests).toEqual([]);
});

it.each([
	['an empty', [] as string[]],
	['a partial', ['clerk.beatcode.org', 'clk2._domainkey.beatcode.org']]
])('refuses %s manifest before any Cloudflare request', async (_, kept) => {
	const records = manifest.records.filter((record) => kept.includes(record.name));
	const missing = manifest.records
		.filter((record) => !kept.includes(record.name))
		.map((record) => record.name);
	for (const apply of [false, true]) {
		const result = await sync(records, { apply });
		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain(
			`Manifest is missing owned DNS records: ${missing.join(', ')}.`
		);
		expect(result.requests).toEqual([]);
	}
});

it('refuses a manifest record whose TTL is not Cloudflare automatic', async () => {
	const records = manifest.records.map((record, index) =>
		index === 0 ? { ...record, ttl: 300 } : record
	);
	const result = await sync(records, { apply: true });
	expect(result.code).not.toBe(0);
	expect(result.stderr).toContain('Manifest contains an invalid, duplicate or unowned DNS record.');
	expect(result.requests).toEqual([]);
});

it('updates a managed record whose TTL drifted and leaves matching records unchanged', async () => {
	const result = await sync(manifest.records, {
		apply: true,
		existing: {
			...existing('clerk.beatcode.org', { ttl: 300 }),
			...existing('accounts.beatcode.org')
		}
	});
	expect(result.code).toBe(0);
	expect(result.stdout).toContain('Updated: clerk.beatcode.org\n');
	expect(result.stdout).toContain('Unchanged: accounts.beatcode.org\n');
	expect(result.writes.filter((write) => write.method === 'PATCH')).toEqual([
		{
			method: 'PATCH',
			path: '/client/v4/zones/zone/dns_records/current',
			body: {
				type: 'CNAME',
				name: 'clerk.beatcode.org',
				content: 'frontend-api.clerk.services',
				proxied: false,
				ttl: 1,
				comment: 'beatcode-managed'
			}
		}
	]);
});

it('refuses to change an unmanaged record', async () => {
	const result = await sync(manifest.records, {
		apply: true,
		existing: existing('clerk.beatcode.org', { content: 'elsewhere.example', comment: undefined })
	});
	expect(result.code).not.toBe(0);
	expect(result.stderr).toContain(
		'An unmanaged record exists for clerk.beatcode.org; refusing to change it.'
	);
	expect(result.writes).toEqual([]);
});
