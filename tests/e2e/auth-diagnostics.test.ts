import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Page } from '@playwright/test';
import { observeAuthBoundary } from './auth-diagnostics';

// Exercise the registered Playwright page callbacks with synthetic events. This
// proves categorisation and suppression, never what Clerk returned in CI.
const app = 'http://localhost:4173';
const fapi = 'https://ci-instance.clerk.accounts.dev';
const canaries = [
	'canary@example.invalid',
	'testing-token-canary',
	'sess_canary',
	'private vendor message',
	'ci-instance'
];
function boundary() {
	const page = new EventEmitter();
	const observer = observeAuthBoundary(page as unknown as Page, app);
	const request = (url: string, errorText?: string) => ({
		url: () => url,
		failure: () => (errorText === undefined ? null : { errorText })
	});
	const respond = (url: string, status: number, body?: unknown, headers = {}) => {
		page.emit('request', request(url));
		page.emit('response', {
			url: () => url,
			status: () => status,
			headers: () => headers,
			json: () =>
				body instanceof Promise
					? body
					: body === undefined
						? Promise.reject(new Error('private vendor message'))
						: Promise.resolve(body)
		});
	};
	const fail = (url: string, errorText: string) => {
		page.emit('request', request(url));
		page.emit('requestfailed', request(url, errorText));
	};
	return { page, observer, respond, fail };
}
afterEach(() => {
	vi.useRealTimers();
});
const parse = (line: string | undefined) => {
	expect(line).toMatch(/^CI auth boundary: /);
	for (const canary of canaries) expect(line).not.toContain(canary);
	return JSON.parse(line!.slice('CI auth boundary: '.length));
};

it('reports a rate-limited session load by endpoint, status and allowlisted code only', async () => {
	const b = boundary();
	const secret = '?__clerk_testing_token=testing-token-canary&email=canary@example.invalid';
	b.respond(`${fapi}/v1/dev_browser${secret}`, 200, {});
	b.respond(
		`${fapi}/v1/environment${secret}`,
		429,
		{ errors: [{ code: 'too_many_requests', message: 'private vendor message' }] },
		{ 'retry-after': '7' }
	);
	b.respond(`${fapi}/v1/client${secret}`, 403, {
		errors: [{ code: 'sess_canary', message: 'private vendor message' }]
	});
	b.respond(`${fapi}/v1/client/sessions/sess_canary/touch`, 502);
	expect(parse(await b.observer.line())).toEqual({
		clerkRequests: 4,
		clerkOk: 1,
		problems: [
			{ endpoint: 'environment', outcome: '429', code: 'too_many_requests' },
			{ endpoint: 'client', outcome: '403', code: 'other' },
			{ endpoint: 'client_action', outcome: '5xx', code: 'none' }
		],
		retryAfter: true,
		appAssetFailures: 0,
		csp: false,
		pageErrors: 0
	});
});

// Texts captured from real unrouted failures in Playwright's three engines.
it.each([
	['net::ERR_NAME_NOT_RESOLVED', 'failed_dns'],
	['NS_ERROR_UNKNOWN_HOST', 'failed_dns'],
	['Error resolving “ci-instance.clerk.accounts.dev”: Name or service not known', 'failed_dns'],
	['net::ERR_INTERNET_DISCONNECTED', 'failed_offline'],
	['net::ERR_CONNECTION_REFUSED', 'failed_connection'],
	['NS_ERROR_NET_RESET', 'failed_connection'],
	['Could not connect to ci-instance: Connection refused', 'failed_connection'],
	['Error receiving data: Connection reset by peer', 'failed_connection'],
	['Connection terminated unexpectedly', 'failed_connection'],
	['net::ERR_TIMED_OUT', 'failed_timeout'],
	['NS_ERROR_NET_TIMEOUT', 'failed_timeout'],
	['net::ERR_ABORTED', 'failed_cancelled'],
	['net::ERR_BLOCKED_BY_CLIENT.Inspector', 'failed_blocked'],
	['net::ERR_FAILED', 'failed_other'],
	['private vendor message canary@example.invalid', 'failed_other']
])('classifies transport failure %j as %s without echoing it', async (text, outcome) => {
	const b = boundary();
	b.fail(`${fapi}/v1/environment?__clerk_testing_token=testing-token-canary`, text);
	expect(parse(await b.observer.line()).problems).toEqual([
		{ endpoint: 'environment', outcome, code: 'none' }
	]);
});

it('separates SDK asset, CSP and script failures from Clerk traffic', async () => {
	const b = boundary();
	b.fail(`${app}/_app/immutable/chunks/sdk.js`, 'net::ERR_FAILED');
	b.respond(`${app}/_app/immutable/chunks/other.js`, 404);
	// Lookalike hosts and other origins are neither Clerk traffic nor app assets.
	b.respond('https://ci-instance.clerk.accounts.dev.example.invalid/v1/environment', 429);
	b.respond('https://cdn.example.invalid/_app/immutable/x.js', 500);
	b.page.emit('console', {
		text: () =>
			'Refused to connect to https://ci-instance.clerk.accounts.dev/v1/environment because it does not appear in the connect-src directive of the Content Security Policy.'
	});
	b.page.emit('pageerror', new Error('private vendor message'));
	expect(parse(await b.observer.line())).toEqual({
		clerkRequests: 0,
		clerkOk: 0,
		problems: [],
		retryAfter: false,
		appAssetFailures: 2,
		csp: true,
		pageErrors: 1
	});
});

it('bounds repeated failures and stops observing after close', async () => {
	const b = boundary();
	for (let i = 0; i < 120; i++) b.respond(`${fapi}/v1/environment`, 429);
	const bounded = parse(await b.observer.line());
	expect(bounded.clerkRequests).toBe(99);
	expect(bounded.problems).toHaveLength(4);
	b.observer.close();
	b.respond(`${fapi}/v1/client`, 200);
	expect(parse(await b.observer.line()).clerkOk).toBe(0);
});

it('reports a known HTTP failure even when its body never arrives', async () => {
	vi.useFakeTimers();
	const b = boundary();
	b.respond(`${fapi}/v1/environment`, 429, new Promise(() => {}), { 'retry-after': '7' });
	b.respond(`${fapi}/v1/client`, 503, new Promise(() => {}));
	const line = b.observer.line();
	await vi.advanceTimersByTimeAsync(10_000);
	const result = parse(await line);
	expect(result.problems).toEqual([
		{ endpoint: 'environment', outcome: '429', code: 'none' },
		{ endpoint: 'client', outcome: '5xx', code: 'none' }
	]);
	expect(result.retryAfter).toBe(true);
});

it('ignores a body that settles after close and leaves no timer behind', async () => {
	vi.useFakeTimers();
	const b = boundary();
	let settle!: (body: unknown) => void;
	b.respond(`${fapi}/v1/environment`, 429, new Promise((accept) => (settle = accept)));
	b.observer.close();
	settle({ errors: [{ code: 'too_many_requests' }] });
	// Every body has settled, so the line is ready without advancing time.
	expect(parse(await b.observer.line()).problems).toEqual([
		{ endpoint: 'environment', outcome: '429', code: 'none' }
	]);
	expect(vi.getTimerCount()).toBe(0);
});
