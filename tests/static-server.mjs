import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

// Serve the adapter's actual output, including its fallback and generated
// Cloudflare headers. Kit's Vite preview renders a different bootstrap.
const root = resolve('build');
const redirects = (await readFile(resolve(root, '_redirects'), 'utf8'))
	.trim()
	.split('\n')
	.filter(Boolean)
	.map((line) => {
		const [from, to] = line.split(/\s+/);
		return { pattern: new RegExp('^' + from.replace(/:[A-Za-z]\w*/g, '[^/]+') + '/?$'), to };
	});
const rules = await readFile(resolve(root, '_headers'), 'utf8');
const headerRules = rules
	.trim()
	.split('\n\n')
	.map((block) => {
		const [pattern, ...lines] = block.split('\n');
		return {
			pattern: new RegExp(
				'^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
			),
			headers: Object.fromEntries(
				lines.filter(Boolean).map((line) => {
					const colon = line.indexOf(':');
					return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
				})
			)
		};
	});
/** @type {Record<string, string>} */
const types = {
	'.html': 'text/html',
	'.js': 'application/javascript',
	'.css': 'text/css',
	'.svg': 'image/svg+xml',
	'.json': 'application/json',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf'
};
createServer(async (request, response) => {
	try {
		const path = resolve(
			root,
			'.' + decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
		);
		if (path !== root && !path.startsWith(root + sep)) {
			response.writeHead(403).end();
			return;
		}
		const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
		const proxy = redirects.find((rule) => rule.pattern.test(pathname));
		const headers = Object.assign(
			{},
			...headerRules.filter((rule) => rule.pattern.test(pathname)).map((rule) => rule.headers)
		);
		const assetPath = proxy ? resolve(root, '.' + proxy.to) : path;
		const candidates = [assetPath, assetPath + '.html', resolve(assetPath, 'index.html')];
		let file;
		let body;
		for (const candidate of candidates) {
			try {
				body = await readFile(candidate);
				file = candidate;
				break;
			} catch {
				/* Try the next static HTML spelling. */
			}
		}
		if (!file) {
			if (!request.headers.accept?.includes('text/html')) {
				response.writeHead(404).end();
				return;
			}
			// Cloudflare's configured SPA default for otherwise unmatched URLs.
			file = resolve(root, 'index.html');
			body = await readFile(file);
		}
		response.writeHead(200, {
			...headers,
			'Content-Type': types[extname(file)] ?? 'application/octet-stream'
		});
		response.end(body);
	} catch {
		response.writeHead(500).end();
	}
}).listen(4173, '0.0.0.0');
