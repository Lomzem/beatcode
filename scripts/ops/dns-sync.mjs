import { readFile } from 'node:fs/promises';
import { Data, Effect } from 'effect';

class DnsSyncError extends Data.TaggedError('DnsSyncError') {}

const synchronize = Effect.gen(function* () {
	const manifestText = yield* Effect.tryPromise({
		try: () => readFile(process.argv[2] ?? 'ops/dns.json', 'utf8'),
		catch: () => new DnsSyncError({ message: 'DNS manifest could not be read.' })
	});
	const manifest = yield* Effect.try({
		try: () => JSON.parse(manifestText),
		catch: () => new DnsSyncError({ message: 'DNS manifest is invalid JSON.' })
	});
	const apply = process.argv.includes('--apply');
	const domain = manifest.zone;
	const owned = new Set(['clerk', 'accounts', 'clkmail', 'clk._domainkey', 'clk2._domainkey']);
	if (domain !== 'beatcode.org' || !Array.isArray(manifest.records)) {
		return yield* new DnsSyncError({ message: 'Expected the explicit beatcode.org DNS manifest.' });
	}
	const names = new Set();
	for (const record of manifest.records) {
		const prefix = record.name?.slice(0, -`.${domain}`.length);
		if (
			record.type !== 'CNAME' ||
			!record.name?.endsWith(`.${domain}`) ||
			!owned.has(prefix) ||
			names.has(record.name) ||
			record.proxied !== false ||
			record.ttl !== 1 ||
			typeof record.content !== 'string' ||
			!/^[a-z0-9_.-]+$/i.test(record.content) ||
			!record.content.includes('.')
		)
			return yield* new DnsSyncError({
				message: 'Manifest contains an invalid, duplicate or unowned DNS record.'
			});
		names.add(record.name);
	}
	const missing = [...owned]
		.map((prefix) => `${prefix}.${domain}`)
		.filter((name) => !names.has(name));
	if (missing.length > 0)
		return yield* new DnsSyncError({
			message: `Manifest is missing owned DNS records: ${missing.join(', ')}.`
		});
	if (!apply) {
		console.log(`Validated ${manifest.records.length} DNS-only Clerk CNAME records for ${domain}.`);
		return;
	}
	const token = process.env.CLOUDFLARE_API_TOKEN;
	const account = process.env.CLOUDFLARE_ACCOUNT_ID;
	if (!token || !account)
		return yield* new DnsSyncError({ message: 'Cloudflare deployment credentials are missing.' });

	function api(path, method = 'GET', body = undefined) {
		return Effect.gen(function* () {
			const response = yield* Effect.tryPromise({
				try: () =>
					fetch(`https://api.cloudflare.com/client/v4${path}`, {
						method,
						headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
						body: body === undefined ? undefined : JSON.stringify(body),
						signal: AbortSignal.timeout(30_000)
					}),
				catch: () => new DnsSyncError({ message: `Cloudflare ${method} request failed.` })
			});
			const data = yield* Effect.tryPromise({
				try: () => response.json(),
				catch: () => new DnsSyncError({ message: 'Cloudflare response was invalid.' })
			});
			if (!response.ok || !data.success) {
				const codes = (data.errors ?? []).map((error) => Number(error.code)).join(',');
				return yield* new DnsSyncError({
					message: `Cloudflare ${method} failed (${response.status}; codes ${codes}).`
				});
			}
			return data.result;
		});
	}

	const zones = yield* api(
		`/zones?${new URLSearchParams({ name: domain, 'account.id': account })}`
	);
	if (zones.length !== 1 || zones[0].account.id !== account || zones[0].status !== 'active') {
		return yield* new DnsSyncError({
			message: 'The purchased zone is not active in the selected account.'
		});
	}
	const zone = zones[0].id;
	for (const record of manifest.records) {
		const records = yield* api(
			`/zones/${zone}/dns_records?${new URLSearchParams({ name: record.name })}`
		);
		if (records.length > 1)
			return yield* new DnsSyncError({
				message: `Multiple records exist for ${record.name}; refusing to replace them.`
			});
		const current = records[0];
		const matches =
			current?.type === record.type &&
			current.content.replace(/\.$/, '').toLowerCase() ===
				record.content.replace(/\.$/, '').toLowerCase() &&
			current.proxied === false &&
			current.ttl === record.ttl;
		if (matches) {
			console.log(`Unchanged: ${record.name}`);
			continue;
		}
		if (current && current.comment !== 'beatcode-managed') {
			return yield* new DnsSyncError({
				message: `An unmanaged record exists for ${record.name}; refusing to change it.`
			});
		}
		yield* api(
			`/zones/${zone}/dns_records${current ? `/${current.id}` : ''}`,
			current ? 'PATCH' : 'POST',
			{
				type: 'CNAME',
				name: record.name,
				content: record.content,
				proxied: false,
				ttl: record.ttl,
				comment: 'beatcode-managed'
			}
		);
		console.log(`${current ? 'Updated' : 'Created'}: ${record.name}`);
	}
});

await Effect.runPromise(synchronize);
