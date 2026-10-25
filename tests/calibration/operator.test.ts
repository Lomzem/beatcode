import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Effect, Fiber } from 'effect';
import { devCall } from '../../scripts/problems/operator';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: vi.fn(), mkdirSync: vi.fn(), writeFileSync: vi.fn() }));

// Offline HTTP fixture for the installed Convex SDK; no deployment is contacted.
const key = 'dev:descriptive-scorpion-877|fixture-not-a-credential';
const remote = {
	requests: [] as { url: string; authorization: string | null; name: string; args: unknown }[],
	handle: (() => null) as (name: string, args: Record<string, unknown>) => unknown,
	reply: undefined as Response | undefined
};
const devRun = <T>(name: string, args: Record<string, unknown>) =>
	Effect.runPromise(devCall<T>(name, args));

beforeEach(() => {
	vi.mocked(readFileSync).mockReturnValue('CONVEX_DEPLOYMENT=dev:descriptive-scorpion-877\n');
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
	vi.stubEnv('CONVEX_DEV_DEPLOY_KEY', key);
	remote.requests = [];
	remote.reply = undefined;
	remote.handle = () => null;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body));
			remote.requests.push({
				url: String(url),
				authorization: new Headers(init.headers).get('Authorization'),
				name: body.path,
				args: body.args
			});
			if (remote.reply) return remote.reply;
			try {
				const value = await remote.handle(body.path, body.args);
				return Response.json({ status: 'success', value: value ?? null, logLines: [] });
			} catch (error) {
				return Response.json(
					{ status: 'error', errorMessage: String(error), logLines: [] },
					{ status: 560 }
				);
			}
		})
	);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe('DEV operator transport', () => {
	it('sends an accepted maximum-size package in process to the pinned admin endpoint', async () => {
		// Each argument alone exceeds Linux's 128KiB per-argv-string limit.
		const statementMd = 's'.repeat(65536);
		const referenceSolutions = {
			accepted: Array.from({ length: 5 }, (_, i) => `${i}`.repeat(65536)),
			timeLimitExceeded: ['t'.repeat(65536)],
			wrongAnswer: ['w'.repeat(4000)],
			validator: 'v'.repeat(400000 - 6 * 65536 - 4000)
		};
		remote.handle = () => ({ problemVersionId: 'version' });
		await expect(
			devRun('problems:_createVersion', { slug: 'fixture', statementMd, referenceSolutions })
		).resolves.toEqual({ problemVersionId: 'version' });
		expect(remote.requests).toEqual([
			{
				url: 'https://descriptive-scorpion-877.convex.cloud/api/function',
				authorization: `Convex ${key}`,
				name: 'problems:_createVersion',
				args: { slug: 'fixture', statementMd, referenceSolutions }
			}
		]);
		expect(execFileSync).not.toHaveBeenCalled();
	});
	it('acknowledges a successful void mutation as undefined', async () => {
		await expect(
			devRun('calibrationState:_finish', { reservationId: 'reservation' })
		).resolves.toBeUndefined();
		remote.handle = () => ({ released: true });
		await expect(devRun('calibration:status', {})).resolves.toEqual({ released: true });
	});
	it.each([
		[
			'the pinned environment file names another deployment',
			'DEV_DEPLOYMENT_REQUIRED',
			() => vi.mocked(readFileSync).mockReturnValue('CONVEX_DEPLOYMENT=prod:careful-greyhound-596')
		],
		[
			'the process selects another deployment',
			'DEV_DEPLOYMENT_REQUIRED',
			() => vi.stubEnv('CONVEX_DEPLOYMENT', 'prod:careful-greyhound-596')
		],
		[
			'the process selects another cloud URL',
			'DEV_DEPLOYMENT_REQUIRED',
			() => vi.stubEnv('CONVEX_CLOUD_URL', 'https://careful-greyhound-596.convex.cloud')
		],
		[
			'the DEV key is absent',
			'DEV_AUTH_REQUIRED',
			() => vi.stubEnv('CONVEX_DEV_DEPLOY_KEY', undefined)
		],
		[
			'the key belongs to production',
			'DEV_AUTH_REQUIRED',
			() =>
				vi.stubEnv('CONVEX_DEV_DEPLOY_KEY', 'prod:careful-greyhound-596|fixture-not-a-credential')
		],
		[
			'a generic Convex key is also present',
			'DEV_AUTH_REQUIRED',
			() => vi.stubEnv('CONVEX_DEPLOY_KEY', key)
		]
	])('blocks dispatch when %s', async (_case, message, arrange) => {
		arrange();
		await expect(devRun('calibration:status', {})).rejects.toThrow(message);
		expect(remote.requests).toEqual([]);
	});
	it('sanitizes remote, network and decode failures without retaining payloads or keys', async () => {
		const secret = 'PRIVATE_HIDDEN_SOURCE';
		const failures: unknown[] = [];
		const capture = (name: string) =>
			Effect.runPromise(Effect.flip(devCall(name, { source: secret })));
		remote.handle = () => {
			throw new Error(secret);
		};
		failures.push(await capture('calibration:_job'));
		vi.mocked(fetch).mockRejectedValueOnce(new Error(`${secret} ${key}`));
		failures.push(await capture('calibration:_job'));
		remote.reply = new Response(`${secret}-malformed`, { status: 200 });
		failures.push(await capture('calibration:status'));
		expect(failures.map((failure) => (failure as Error).message)).toEqual([
			'DEV_OPERATOR_CALL_FAILED:calibration:_job',
			'DEV_OPERATOR_CALL_FAILED:calibration:_job',
			'DEV_OPERATOR_OUTPUT_INVALID:calibration:status'
		]);
		for (const failure of failures) {
			const exposed = JSON.stringify(failure) + String((failure as Error).stack);
			expect(exposed).not.toContain(secret);
			expect(exposed).not.toContain('fixture-not-a-credential');
		}
	});
	it('aborts the in-flight request when the call is interrupted', async () => {
		let sent: (signal: AbortSignal) => void = () => {};
		const request = new Promise<AbortSignal>((resolve) => (sent = resolve));
		vi.mocked(fetch).mockImplementationOnce(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					const signal = init!.signal!;
					signal.addEventListener('abort', () => reject(signal.reason));
					sent(signal);
				})
		);
		const call = Effect.runFork(devCall('calibration:_job', { reservationId: 'reservation' }));
		const signal = await request;
		expect(signal.aborted).toBe(false);
		await Effect.runPromise(Fiber.interrupt(call));
		expect(signal.aborted).toBe(true);
	});
	it('aborts a pending request at the deadline without interruption, not before the action limit', async () => {
		// Node's AbortSignal.timeout runs on internal timers that fake timers cannot advance, so the
		// native timer runs 1000x faster. Real clock accuracy is not under test.
		const scale = 1000;
		const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
		let armed = 0;
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
			armed = performance.now();
			return nativeTimeout(ms / scale);
		});
		let reason: unknown;
		let waited = 0;
		vi.mocked(fetch).mockImplementationOnce(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					const signal = init!.signal!;
					signal.addEventListener('abort', () => {
						waited = (performance.now() - armed) * scale;
						reject((reason = signal.reason));
					});
				})
		);
		const call = Effect.runFork(
			Effect.flip(devCall('calibration:_job', { reservationId: 'reservation' }))
		);
		// A missing deadline leaves the request pending past the Vitest timeout, which does not
		// cancel the test body; release the request and the spy however the test ends.
		onTestFinished(async () => {
			await Effect.runPromise(Fiber.interrupt(call));
			timeout.mockRestore();
		});
		const failure = await Effect.runPromise(Fiber.join(call));
		expect(failure.message).toBe('DEV_OPERATOR_CALL_FAILED:calibration:_job');
		expect((reason as Error).name).toBe('TimeoutError');
		// Convex actions may run for 10 minutes; the client must not give up first.
		expect(waited).toBeGreaterThanOrEqual(600_000);
	});
});

it.each([false, true])(
	'the operator rejudges only the exact selected receipt with explicit approval=%s',
	async (approved) => {
		vi.resetModules();
		const argv = process.argv;
		const output = vi.spyOn(console, 'log').mockImplementation(() => {});
		const dispatched: { name: string; args: Record<string, unknown> }[] = [];
		remote.handle = (name, args) => {
			dispatched.push({ name, args });
			if (name === 'calibrationState:_status')
				return {
					executionPolicy: 'staged-input-reference-10s-v1',
					jobs: [
						{
							reservationId: 'selected-primary',
							problemVersionId: 'version',
							role: 'timeLimitExceeded',
							index: 0,
							repeat: 7,
							executionPolicy: 'staged-input-reference-10s-v1',
							released: true
						}
					]
				};
			if (name === 'calibration:_job') return { verdict: 'TLE' };
			throw new Error('Unexpected operator dispatch');
		};
		try {
			process.argv = [
				'node',
				'calibrate.ts',
				'version',
				'--retry-error',
				'selected-primary',
				...(approved ? ['--approve-empty-error-once'] : [])
			];
			const running = import('../../scripts/problems/calibrate');
			if (approved) await running;
			else await expect(running).rejects.toThrow('EXPLICIT_REJUDGE_APPROVAL_REQUIRED');
			expect(dispatched.filter((call) => call.name !== 'calibrationState:_status')).toEqual(
				approved
					? [
							{
								name: 'calibration:_job',
								args: {
									problemVersionId: 'version',
									role: 'timeLimitExceeded',
									index: 0,
									repeat: 7,
									retryOf: 'selected-primary',
									retryApproval: 'reviewed-empty-error-once'
								}
							}
						]
					: []
			);
		} finally {
			process.argv = argv;
			output.mockRestore();
		}
	}
);

it.each([false, true])(
	'resumes named all-history partial history without extra accepted dispatch; old failure=%s',
	async (oldFailure) => {
		vi.resetModules();
		const argv = process.argv;
		const output = vi.spyOn(console, 'log').mockImplementation(() => {});
		const dispatched: { name: string; args: Record<string, unknown> }[] = [];
		const jobs = [
			...Array.from({ length: 15 }, (_, repeat) => ({
				role: 'accepted',
				index: 0,
				repeat,
				wall: repeat === 7 ? 268 : 69
			})),
			{ role: 'validator', index: 0, repeat: 0, wall: 1 },
			{ role: 'validator', index: 1, repeat: 0, wall: 1 },
			{ role: 'slowSample', index: 0, repeat: 0, wall: 1 }
		].map((j, i) => ({
			...j,
			reservationId: `receipt-${i}`,
			problemVersionId: 'version',
			executionPolicy: 'staged-input-reference-10s-v1',
			released: true,
			result: {
				verdict: oldFailure && i === 0 ? 'WA' : 'AC',
				slowestTestMs: j.wall,
				aggregateMs: j.wall,
				attemptWallMs: 1000,
				testWallMs: [j.wall],
				execObservedMs: [j.wall]
			}
		}));
		remote.handle = (name, args) => {
			dispatched.push({ name, args });
			if (name === 'calibrationState:_status')
				return { executionPolicy: 'staged-input-reference-10s-v1', jobs };
			if (name === 'problems:_calibrationInput')
				return {
					version: {
						referenceSolutions: {
							accepted: ['fixture'],
							timeLimitExceeded: ['fixture'],
							wrongAnswer: ['fixture']
						}
					}
				};
			if (name === 'calibration:_job')
				return {
					verdict: args.role === 'wrongAnswer' ? 'WA' : args.role === 'accepted' ? 'AC' : 'TLE',
					slowestTestMs: 69,
					aggregateMs: 69,
					attemptWallMs: 1000
				};
			if (name === 'calibration:_finalize') return { activated: true };
			throw new Error('Unexpected dispatch');
		};
		try {
			process.argv = [
				'node',
				'calibrate.ts',
				'version',
				'--decision-policy',
				'alpha-complexity-all-history-v1'
			];
			const running = import('../../scripts/problems/calibrate');
			if (oldFailure) {
				await expect(running).rejects.toThrow('ALL_HISTORY_ACCEPTED_EVIDENCE_FAILED');
				expect(dispatched.filter((c) => c.name === 'calibration:_job')).toEqual([]);
				return;
			}
			await running;
			expect(
				dispatched.filter((c) => c.name === 'calibration:_job').map((c) => c.args.role)
			).toEqual([
				'timeLimitExceeded',
				'timeLimitExceeded',
				'timeLimitExceeded',
				'timeLimitExceeded',
				'timeLimitExceeded',
				'timeLimitExceeded',
				'timeLimitExceeded',
				'timeLimitExceeded',
				'wrongAnswer'
			]);
			expect(dispatched.at(-1)).toEqual({
				name: 'calibration:_finalize',
				args: { problemVersionId: 'version', decisionPolicy: 'alpha-complexity-all-history-v1' }
			});
		} finally {
			process.argv = argv;
			output.mockRestore();
		}
	}
);
