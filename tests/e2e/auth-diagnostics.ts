import type { Page, Request, Response, ConsoleMessage } from '@playwright/test';

const prefix = 'CI auth boundary: ';
const endpoints = ['environment', 'client', 'client_action', 'dev_browser', 'other'] as const;
const outcomes = ['3xx', '400', '401', '403', '404', '422', '429', '4xx', '5xx'] as const;
const failures = [
	'dns',
	'offline',
	'connection',
	'timeout',
	'cancelled',
	'blocked',
	'other'
] as const;
// Clerk Frontend API error codes relevant to session loading. Anything else is
// reported as `other`; vendor messages and identifiers never leave the browser.
const codes = [
	'too_many_requests',
	'authentication_invalid',
	'dev_browser_unauthenticated',
	'origin_invalid',
	'captcha_invalid',
	'signup_rate_limit_exceeded',
	'other',
	'none'
] as const;
type Endpoint = (typeof endpoints)[number];
type Problem = {
	endpoint: Endpoint;
	outcome: (typeof outcomes)[number] | `failed_${(typeof failures)[number]}`;
	code: (typeof codes)[number];
};
export type AuthBoundary = {
	clerkRequests: number;
	clerkOk: number;
	problems: Problem[];
	retryAfter: boolean;
	appAssetFailures: number;
	csp: boolean;
	pageErrors: number;
};

const cap = (value: number) => Math.min(99, value);
const problemOutcomes = [...outcomes, ...failures.map((kind) => `failed_${kind}`)];

function endpoint(pathname: string): Endpoint {
	if (pathname === '/v1/environment') return 'environment';
	if (pathname === '/v1/client') return 'client';
	if (pathname.startsWith('/v1/client/')) return 'client_action';
	if (pathname.startsWith('/v1/dev_browser')) return 'dev_browser';
	return 'other';
}
function statusOutcome(status: number): Problem['outcome'] | undefined {
	if (status < 300) return;
	if (status < 400) return '3xx';
	const exact = String(status);
	if ((outcomes as readonly string[]).includes(exact)) return exact as Problem['outcome'];
	return status < 500 ? '4xx' : '5xx';
}
// Chromium, Firefox and WebKit report transport failures with different text.
// Patterns were captured from real unrouted failures in each Playwright engine.
function failureKind(text: string): (typeof failures)[number] {
	if (/NAME_NOT_RESOLVED|UNKNOWN_HOST|Error resolving|Name or service not known/i.test(text))
		return 'dns';
	if (/INTERNET_DISCONNECTED|NS_ERROR_OFFLINE/i.test(text)) return 'offline';
	if (/TIMED_OUT|NET_TIMEOUT|timed out/i.test(text)) return 'timeout';
	if (/BLOCKED|ACCESS_DENIED|access control/i.test(text)) return 'blocked';
	if (/ABORTED|NS_ERROR_ABORT|cancel/i.test(text)) return 'cancelled';
	if (
		/CONNECTION_|NET_RESET|NET_INTERRUPT|connection (?:terminated|refused|reset|was lost)|could not connect/i.test(
			text
		)
	)
		return 'connection';
	return 'other';
}
function clerkPath(url: string) {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' &&
			parsed.hostname.endsWith('.clerk.accounts.dev') &&
			parsed.pathname.startsWith('/v1/')
			? parsed.pathname
			: undefined;
	} catch {
		return;
	}
}
function appAsset(url: string, origin: string) {
	try {
		const parsed = new URL(url);
		return parsed.origin === origin && parsed.pathname.startsWith('/_app/');
	} catch {
		return false;
	}
}
async function errorCode(response: Response): Promise<Problem['code']> {
	try {
		const body: unknown = await response.json();
		const errors = (body as { errors?: unknown })?.errors;
		const code = Array.isArray(errors) ? (errors[0] as { code?: unknown })?.code : undefined;
		if (typeof code !== 'string') return 'none';
		return (codes as readonly string[]).includes(code) ? (code as Problem['code']) : 'other';
	} catch {
		return 'none';
	}
}

/** Records categorical evidence for Clerk session loading on one page. */
export function observeAuthBoundary(page: Page, appOrigin: string) {
	const state: AuthBoundary = {
		clerkRequests: 0,
		clerkOk: 0,
		problems: [],
		retryAfter: false,
		appAssetFailures: 0,
		csp: false,
		pageErrors: 0
	};
	const pending = new Set<Promise<void>>();
	let closed = false;
	const problem = (row: Problem) => {
		if (state.problems.length >= 4) return false;
		state.problems.push(row);
		return true;
	};
	const onRequest = (request: Request) => {
		if (clerkPath(request.url())) state.clerkRequests = cap(state.clerkRequests + 1);
	};
	const onResponse = (response: Response) => {
		const url = response.url();
		const path = clerkPath(url);
		const status = response.status();
		if (!path) {
			if (status >= 400 && appAsset(url, appOrigin))
				state.appAssetFailures = cap(state.appAssetFailures + 1);
			return;
		}
		const outcome = statusOutcome(status);
		if (!outcome) {
			state.clerkOk = cap(state.clerkOk + 1);
			return;
		}
		if (response.headers()['retry-after'] !== undefined) state.retryAfter = true;
		// Record the status now; a body that never arrives must not hide it.
		const row: Problem = { endpoint: endpoint(path), outcome, code: 'none' };
		if (!problem(row)) return;
		const read = errorCode(response).then((code) => {
			if (!closed) row.code = code;
		});
		pending.add(read);
		void read.finally(() => pending.delete(read));
	};
	const onFailed = (request: Request) => {
		const url = request.url();
		const path = clerkPath(url);
		if (path)
			problem({
				endpoint: endpoint(path),
				outcome: `failed_${failureKind(request.failure()?.errorText ?? '')}`,
				code: 'none'
			});
		else if (appAsset(url, appOrigin)) state.appAssetFailures = cap(state.appAssetFailures + 1);
	};
	const onConsole = (message: ConsoleMessage) => {
		if (/Content[- ]Security[- ]Policy/i.test(message.text())) state.csp = true;
	};
	const onPageError = () => {
		state.pageErrors = cap(state.pageErrors + 1);
	};
	page.on('request', onRequest);
	page.on('response', onResponse);
	page.on('requestfailed', onFailed);
	page.on('console', onConsole);
	page.on('pageerror', onPageError);
	return {
		/** Settles pending body reads (bounded) and returns the sanitized stdout line. */
		async line() {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					Promise.allSettled([...pending]),
					new Promise((accept) => (timer = setTimeout(accept, 1000)))
				]);
			} finally {
				clearTimeout(timer);
			}
			return safeAuthBoundary(prefix + JSON.stringify(state));
		},
		close() {
			closed = true;
			page.off('request', onRequest);
			page.off('response', onResponse);
			page.off('requestfailed', onFailed);
			page.off('console', onConsole);
			page.off('pageerror', onPageError);
		}
	};
}

const counter = (value: unknown) =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 99;
const exactKeys = (row: Record<string, unknown>, keys: string[]) =>
	Object.keys(row).length === keys.length && Object.keys(row).every((key) => keys.includes(key));
const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);

// Exact types and keys are rechecked by the external stdout owner. Unknown
// values, vendor errors, URLs and identifiers never reach public output.
export function safeAuthBoundary(line: string): string | undefined {
	if (!line.startsWith(prefix)) return;
	try {
		const r: unknown = JSON.parse(line.slice(prefix.length));
		const keys = [
			'clerkRequests',
			'clerkOk',
			'problems',
			'retryAfter',
			'appAssetFailures',
			'csp',
			'pageErrors'
		];
		if (!isRecord(r) || !exactKeys(r, keys)) return;
		if (
			!counter(r.clerkRequests) ||
			!counter(r.clerkOk) ||
			!counter(r.appAssetFailures) ||
			!counter(r.pageErrors) ||
			typeof r.retryAfter !== 'boolean' ||
			typeof r.csp !== 'boolean' ||
			!Array.isArray(r.problems) ||
			r.problems.length > 4
		)
			return;
		const problems: Problem[] = [];
		for (const p of r.problems as unknown[]) {
			if (
				!isRecord(p) ||
				!exactKeys(p, ['endpoint', 'outcome', 'code']) ||
				!(endpoints as readonly unknown[]).includes(p.endpoint) ||
				!problemOutcomes.includes(p.outcome as string) ||
				!(codes as readonly unknown[]).includes(p.code)
			)
				return;
			problems.push({
				endpoint: p.endpoint as Problem['endpoint'],
				outcome: p.outcome as Problem['outcome'],
				code: p.code as Problem['code']
			});
		}
		return (
			prefix +
			JSON.stringify({
				clerkRequests: r.clerkRequests,
				clerkOk: r.clerkOk,
				problems,
				retryAfter: r.retryAfter,
				appAssetFailures: r.appAssetFailures,
				csp: r.csp,
				pageErrors: r.pageErrors
			})
		);
	} catch {
		return;
	}
}
