import { readFile, readdir, writeFile, rename, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Data, Effect } from 'effect';

class HeaderGenerationError extends Data.TaggedError('HeaderGenerationError') {}

/** @template A @param {string} operation @param {() => Promise<A>} run */
const fileOperation = (operation, run) =>
	Effect.tryPromise({
		try: run,
		catch: () => new HeaderGenerationError({ operation })
	});

const generateHeaders = Effect.gen(function* () {
	const backend = yield* Effect.try({
		try: () => {
			const site = new URL(process.env.BEATCODE_SITE_URL ?? 'https://beatcode.org');
			const backend = new URL(process.env.PUBLIC_CONVEX_URL ?? '');
			if (
				site.origin !== 'https://beatcode.org' ||
				backend.protocol !== 'https:' ||
				!backend.hostname.endsWith('.convex.cloud')
			)
				throw new Error('Invalid origins');
			return backend;
		},
		catch: () => new HeaderGenerationError({ operation: 'validate production origins' })
	});
	const clerk = 'https://clerk.beatcode.org';
	// Cloudflare always uses index.html as its SPA fallback. Keep Kit's rendered
	// homepage separately and proxy only / to it; every other asset keeps normal
	// static resolution and every unmatched URL keeps Kit's client-side router.
	const files = yield* fileOperation('list built pages', () => readdir('build'));
	if (!files.includes('prerendered-home.html')) {
		yield* fileOperation('preserve rendered homepage', () =>
			rename('build/index.html', 'build/prerendered-home.html')
		);
	}
	yield* fileOperation('prepare private route fallback', () =>
		copyFile('build/200.html', 'build/index.html')
	);
	yield* fileOperation('write homepage redirect', () =>
		// Target the canonical asset URL so Cloudflare does not redirect / to it.
		writeFile('build/_redirects', '/ /prerendered-home 200\n')
	);
	// Authorize exact inline bootstrap and preference-script bytes from every page.
	const bootstrapHashes = new Set();
	for (const file of yield* fileOperation('list rendered HTML', () =>
		readdir('build', { recursive: true })
	)) {
		if (!file.endsWith('.html')) continue;
		const html = yield* fileOperation('read rendered HTML', () =>
			readFile(join('build', file), 'utf8')
		);
		for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
			if (/\bsrc\s*=/i.test(match[1]) || !match[2].trim()) continue;
			bootstrapHashes.add(`'sha256-${createHash('sha256').update(match[2]).digest('base64')}'`);
		}
	}
	const policy = [
		"default-src 'self'",
		`script-src 'self' ${clerk} https://challenges.cloudflare.com ${[...bootstrapHashes].sort().join(' ')}`,
		`connect-src 'self' ${backend.origin} wss://${backend.host} ${clerk}`,
		`frame-src ${clerk} https://challenges.cloudflare.com`,
		"img-src 'self' data: https://img.clerk.com",
		"font-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"worker-src 'self' blob:",
		"frame-ancestors 'none'",
		"base-uri 'self'",
		"form-action 'self'"
	].join('; ');
	// Cloudflare joins every matching rule's values, so immutable assets detach the
	// catch-all Cache-Control and keep the other inherited security headers.
	yield* fileOperation('write security headers', () =>
		writeFile(
			'build/_headers',
			`/*\n  Content-Security-Policy: ${policy}\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Content-Type-Options: nosniff\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n  Cache-Control: no-cache\n\n/_app/immutable/*\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable\n`
		)
	);
	console.log('Production security headers generated with explicit app/backend origins.');
});

await Effect.runPromise(generateHeaders);
