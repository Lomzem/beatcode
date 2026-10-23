import { afterEach, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../../convex/schema';
import { start } from './game.fixture';
import { api, internal } from '../../convex/_generated/api';

// The real trusted actions own SDK sessions; no sandbox or contestant code executes.
const sdk = vi.hoisted(() => ({
	fail: false,
	opened: 0,
	closed: 0,
	alive: false,
	create: undefined as undefined | (() => Promise<unknown>),
	terminate: undefined as undefined | (() => Promise<void>),
	poll: undefined as undefined | (() => Promise<number | null>),
	listed: false,
	bornBeforeResponse: false,
	tags: {} as Record<string, string>,
	exec: undefined as undefined | ((argv: string[]) => Promise<unknown>)
}));
const sandboxId = 'sb-1234567890123456789012';
function sandbox() {
	return {
		sandboxId,
		terminate: async () => {
			if (sdk.fail) throw new Error('private termination failure');
			await sdk.terminate?.();
			if (!sdk.poll) sdk.alive = false;
		},
		poll: async () => (sdk.poll ? sdk.poll() : sdk.alive ? null : 0),
		exec: (argv: string[]) => (sdk.exec ? sdk.exec(argv) : Promise.resolve(processFixture(argv)))
	};
}
function processFixture(argv: string[]) {
	const stream = (s: string) =>
		new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new TextEncoder().encode(s));
				c.close();
			}
		});
	const checking = argv[0] === '/usr/bin/sha256sum';
	return {
		stdout: stream(checking ? '0'.repeat(64) + '  /opt/judge/runner' : 'compiler error'),
		stderr: stream(
			checking
				? ''
				: JSON.stringify({
						status: 're',
						wallMs: 1,
						cpuMs: 1,
						minAvailMb: 512,
						diskBaseMb: 0,
						leftover: 0
					})
		),
		stdin: new WritableStream(),
		wait: async () => 0
	};
}
vi.mock('modal', () => ({
	ModalClient: class {
		constructor() {
			sdk.opened++;
		}
		profile = { tokenId: 'fixture', tokenSecret: 'fixture', sandboxV2: false };
		close() {
			sdk.closed++;
		}
		apps = {
			fromName: async () => {
				if (sdk.fail) throw new Error('private SDK diagnostic');
				return { appId: 'fixture' };
			}
		};
		images = { fromId: async () => ({}) };
		sandboxes = {
			create: async (_app: unknown, _image: unknown, config: { tags: Record<string, string> }) => {
				sdk.tags = config.tags;
				if (sdk.bornBeforeResponse) sdk.alive = true;
				await sdk.create?.();
				if (!sdk.bornBeforeResponse) sdk.alive = true;
				return sandbox();
			},
			fromId: async () => {
				if (sdk.fail) throw new Error('private SDK diagnostic');
				return sandbox();
			},
			list: async function* () {
				if (sdk.listed) yield { ...sandbox(), getTags: async () => sdk.tags };
			}
		};
	}
}));
const modules = import.meta.glob('../../convex/**/*.ts');
afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
	sdk.fail = false;
	sdk.opened = 0;
	sdk.closed = 0;
	sdk.alive = false;
	sdk.create = undefined;
	sdk.exec = undefined;
	sdk.terminate = undefined;
	sdk.listed = false;
	sdk.bornBeforeResponse = false;
	sdk.poll = undefined;
	sdk.tags = {};
});
it.each([
	{ action: 'terminate', fail: false },
	{ action: 'terminate', fail: true },
	{ action: 'reap', fail: false },
	{ action: 'reap', fail: true }
] as const)(
	'closes the trusted $action SDK session when transport failure is $fail',
	async ({ action, fail }) => {
		vi.useFakeTimers();
		vi.stubEnv('CONVEX_DEPLOYMENT', 'fixture');
		vi.stubEnv('MODAL_APP_NAME', 'beatcode-fixture');
		vi.stubEnv('MODAL_SANDBOX_V2', '0');
		sdk.fail = fail;
		const t = convexTest(schema, modules);
		const running =
			action === 'terminate'
				? t.action(internal.judgeController._terminate, { sandboxId: 'sb-1234567890123456789012' })
				: t.action(internal.judgeController._reap, {});
		if (action === 'reap' && fail) await expect(running).rejects.toThrow();
		else await running;
		expect(sdk.opened).toBe(1);
		expect(sdk.closed).toBe(1);
	}
);

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}
it('holds capacity and publication through the watchdog and failed SDK termination, then releases once confirmed', async () => {
	const { t, a, b, matchId, roundId, job, at: admittedAt } = await sampleGame();
	const creating = deferred<unknown>();
	const entered = deferred<void>();
	const executing = deferred<never>();
	const enteredExecution = deferred<void>();
	sdk.create = () => {
		entered.resolve();
		return creating.promise;
	};
	sdk.exec = () => {
		enteredExecution.resolve();
		return executing.promise;
	};
	const running = t.action(internal.judgeController._run, job);
	await entered.promise;
	// Create begins at dispatch, but returns only thirty seconds later.
	vi.setSystemTime(admittedAt + 30000);
	creating.resolve(undefined);
	await enteredExecution.promise;
	sdk.fail = true;
	vi.setSystemTime(admittedAt + 45000);
	await t.mutation(internal.judge._watchdog, job);
	await b.mutation(api.samples.run, { roundId, source: 'queued rival', clientRunId: 'rival' });
	expect(await t.mutation(internal.judge._pump, {})).toEqual([]);
	expect((await a.query(api.matches.view, { matchId })).ownSampleRuns[0].status).toBe('pending');
	await t.action(internal.judgeController._terminate, { sandboxId });
	expect(await t.mutation(internal.judge._pump, {})).toEqual([]);
	sdk.fail = false;
	const polling = deferred<number | null>();
	const enteredPoll = deferred<void>();
	sdk.poll = () => {
		enteredPoll.resolve();
		return polling.promise;
	};
	const pendingTermination = t.action(internal.judgeController._terminate, { sandboxId });
	await enteredPoll.promise;
	vi.setSystemTime(admittedAt + 48000);
	polling.resolve(null);
	await pendingTermination;
	expect(await t.mutation(internal.judge._pump, {})).toEqual([]);
	sdk.poll = undefined;
	await t.action(internal.judgeController._terminate, { sandboxId });
	// The trusted cleanup action must acknowledge its owned lease, not just send terminate.
	expect((await a.query(api.matches.view, { matchId })).ownSampleRuns[0].status).toBe(
		'judge_failed'
	);
	expect(
		await t.mutation(internal.judge._complete, {
			...job,
			result: {
				verdict: 'AC',
				phase: 'sample',
				sandboxSeconds: 1,
				actionSeconds: 1
			}
		})
	).toBe(false);
	const replacement = await t.mutation(internal.judge._pump, {});
	expect(replacement).toHaveLength(1);
	await t.action(internal.judgeController._terminate, { sandboxId });
	expect(await t.mutation(internal.judge._pump, {})).toEqual([]);
	// Finish the controller's stale preflight; its finalizer cannot publish.
	// The image check fails once the external process returns.
	executing.reject(new Error('stale preflight'));
	await running;
});

async function sampleGame() {
	vi.useFakeTimers();
	vi.stubEnv('CONVEX_DEPLOYMENT', 'fixture');
	vi.stubEnv('MODAL_APP_NAME', 'beatcode-fixture');
	vi.stubEnv('MODAL_SANDBOX_V2', '0');
	const t = convexTest(schema, modules);
	const game = await start(t);
	await t.mutation(internal.ops.setJudging, { enabled: true });
	await t.mutation(internal.ops.setCaps, {
		maxInFlight: 1,
		dailySecondsCap: 12000,
		monthlySecondsCap: 250000,
		monthlyActionSecondsCap: 115200
	});
	const sample = await game.a.mutation(api.samples.run, {
		roundId: game.roundId,
		source: 'int main(){}',
		clientRunId: 'sample'
	});
	const [job] = await t.mutation(internal.judge._pump, {});
	const at = (await game.a.query(api.matches.view, { matchId: game.matchId })).ownSampleRuns[0]
		.createdAt;
	return { ...game, t, sample, job, at };
}
it('publishes normal compiler feedback only after the controller confirms sandbox termination', async () => {
	const { t, a, b, job, matchId, roundId } = await sampleGame();
	const terminating = deferred<void>();
	const entered = deferred<void>();
	sdk.terminate = () => {
		entered.resolve();
		return terminating.promise;
	};
	const running = t.action(internal.judgeController._run, job);
	await entered.promise;
	await b.mutation(api.samples.run, { roundId, source: 'queued', clientRunId: 'queued' });
	expect((await a.query(api.matches.view, { matchId })).ownSampleRuns[0].status).toBe('pending');
	expect(await t.mutation(internal.judge._pump, {})).toEqual([]);
	terminating.resolve();
	await running;
	expect((await a.query(api.matches.view, { matchId })).ownSampleRuns[0]).toMatchObject({
		status: 'done',
		diagnostics: 'compiler error'
	});
	expect(await t.mutation(internal.judge._pump, {})).toHaveLength(1);
});
it('fences an unknown in-flight create at the ceiling, and recovers its late acknowledgement without executing or publishing', async () => {
	const { t, a, b, job, sample, matchId, roundId, at } = await sampleGame();
	const creating = deferred<unknown>();
	const enteredCreate = deferred<void>();
	const terminating = deferred<void>();
	const enteredTermination = deferred<void>();
	sdk.create = () => {
		enteredCreate.resolve();
		return creating.promise;
	};
	let terminations = 0,
		executions = 0;
	sdk.terminate = () => {
		if (++terminations === 1) {
			enteredTermination.resolve();
			return terminating.promise;
		}
		return Promise.resolve();
	};
	sdk.exec = async () => {
		executions++;
		throw new Error('inactive lease must not execute');
	};
	const running = t.action(internal.judgeController._run, job);
	await enteredCreate.promise;
	vi.setSystemTime(at + 45000);
	await t.mutation(internal.judge._watchdog, job);
	await b.mutation(api.samples.run, { roundId, source: 'rival', clientRunId: 'rival' });
	expect(await t.mutation(internal.judge._pump, {})).toEqual([]);
	vi.setSystemTime(at + 60000);
	creating.resolve(undefined);
	await enteredTermination.promise;
	vi.setSystemTime(at + 90000);
	await t.mutation(internal.samples._ceiling, sample);
	expect((await a.query(api.matches.view, { matchId })).ownSampleRuns[0].status).toBe('pending');
	expect(await t.mutation(internal.judge._pump, {})).toEqual([]);
	expect(
		await t.mutation(internal.judge._complete, {
			...job,
			result: { verdict: 'AC', phase: 'sample', sandboxSeconds: 1, actionSeconds: 1 }
		})
	).toBe(false);
	sdk.fail = true;
	await t.action(internal.judgeController._terminate, { sandboxId, retry: 3 });
	expect(await t.mutation(internal.judge._pump, {})).toEqual([]);
	sdk.fail = false;
	await t.action(internal.judgeController._terminate, { sandboxId });
	terminating.resolve();
	await running;
	expect(executions).toBe(0);
	expect((await a.query(api.matches.view, { matchId })).ownSampleRuns[0].status).toBe(
		'judge_failed'
	);
	expect(await t.mutation(internal.judge._noteSandbox, { ...job, sandboxId })).toBe(false);
	expect(await t.mutation(internal.judge._pump, {})).toHaveLength(1);
});
it('releases a known sandbox at its conservative actual lifetime after all termination retries fail', async () => {
	const { t, a, b, job, matchId, roundId, at } = await sampleGame();
	await t.mutation(internal.judge._claim, job);
	await t.mutation(internal.judge._beginCreate, job);
	vi.setSystemTime(at + 30000);
	await t.mutation(internal.judge._noteSandbox, { ...job, sandboxId });
	sdk.alive = true;
	sdk.fail = true;
	vi.setSystemTime(at + 45000);
	await t.mutation(internal.judge._watchdog, job);
	await b.mutation(api.samples.run, { roundId, source: 'rival', clientRunId: 'rival' });
	for (let retry = 0; retry <= 3; retry++)
		await t.action(internal.judgeController._terminate, { sandboxId, retry });
	vi.setSystemTime(at + 70000);
	await t.mutation(internal.judge._checkCleanup, job);
	expect(await t.mutation(internal.judge._pump, {})).toEqual([]);
	vi.setSystemTime(at + 71001);
	await t.mutation(internal.judge._checkCleanup, job);
	expect((await a.query(api.matches.view, { matchId })).ownSampleRuns[0].status).toBe(
		'judge_failed'
	);
	expect(await t.mutation(internal.judge._pump, {})).toHaveLength(1);
	await t.mutation(internal.judge._checkCleanup, job);
	expect(await t.mutation(internal.judge._pump, {})).toEqual([]);
});

it('recovers an unacknowledged create through the independent tagged SDK reaper', async () => {
	const { t, a, b, job, matchId, roundId, at } = await sampleGame();
	const creating = deferred<unknown>();
	const entered = deferred<void>();
	sdk.bornBeforeResponse = true;
	sdk.listed = true;
	sdk.create = () => {
		entered.resolve();
		return creating.promise;
	};
	let executions = 0;
	sdk.exec = async () => {
		executions++;
		throw new Error('stale create must not execute');
	};
	const running = t.action(internal.judgeController._run, job);
	await entered.promise;
	vi.setSystemTime(at + 45000);
	await t.mutation(internal.judge._watchdog, job);
	await b.mutation(api.samples.run, { roundId, source: 'rival', clientRunId: 'rival' });
	expect(await t.mutation(internal.judge._pump, {})).toEqual([]);
	await t.action(internal.judgeController._reap, {});
	expect((await a.query(api.matches.view, { matchId })).ownSampleRuns[0].status).toBe(
		'judge_failed'
	);
	expect(await t.mutation(internal.judge._pump, {})).toHaveLength(1);
	creating.resolve(undefined);
	await running;
	expect(executions).toBe(0);
	expect(await t.mutation(internal.judge._pump, {})).toEqual([]);
});

it('accepts a lease-bound SDK exit receipt when the sandbox acknowledgement was lost, and ignores a stale lease', async () => {
	const { t, a, b, job, matchId, roundId, at } = await sampleGame();
	await t.mutation(internal.judge._claim, job);
	await t.mutation(internal.judge._beginCreate, job);
	// The external resource exists, but its ID notification never reached Convex.
	sdk.alive = true;
	vi.setSystemTime(at + 45000);
	await t.mutation(internal.judge._watchdog, job);
	await b.mutation(api.samples.run, { roundId, source: 'rival', clientRunId: 'rival' });
	await t.action(internal.judgeController._terminate, {
		sandboxId,
		lease: { ...job, leaseVersion: job.leaseVersion + 1 }
	});
	expect(await t.mutation(internal.judge._pump, {})).toEqual([]);
	expect((await a.query(api.matches.view, { matchId })).ownSampleRuns[0].status).toBe('pending');
	await t.action(internal.judgeController._terminate, { sandboxId, lease: job });
	expect((await a.query(api.matches.view, { matchId })).ownSampleRuns[0].status).toBe(
		'judge_failed'
	);
	expect(await t.mutation(internal.judge._pump, {})).toHaveLength(1);
});

it('reconciles a recovered sandbox that exited before the reaper listed it again', async () => {
	const { t, a, b, job, matchId, roundId, at } = await sampleGame();
	await t.mutation(internal.judge._claim, job);
	await t.mutation(internal.judge._beginCreate, job);
	await t.mutation(internal.judge._noteSandbox, { ...job, sandboxId, creationConfirmed: false });
	vi.setSystemTime(at + 45000);
	await t.mutation(internal.judge._watchdog, job);
	await b.mutation(api.samples.run, { roundId, source: 'rival', clientRunId: 'rival' });
	// A prior cleanup request killed it, but its receipt was lost. Running-only
	// listing omits it, while fromId + poll still supplies the authoritative exit.
	sdk.alive = false;
	sdk.listed = false;
	await t.action(internal.judgeController._reap, {});
	expect((await a.query(api.matches.view, { matchId })).ownSampleRuns[0].status).toBe(
		'judge_failed'
	);
	expect(await t.mutation(internal.judge._pump, {})).toHaveLength(1);
});

it('preserves one immutable scored retry and admission order without turning contestant losses into a void', async () => {
	vi.useFakeTimers();
	vi.stubEnv('CONVEX_DEPLOYMENT', 'fixture');
	vi.stubEnv('MODAL_APP_NAME', 'beatcode-fixture');
	vi.stubEnv('MODAL_SANDBOX_V2', '0');
	const t = convexTest(schema, modules);
	const { a, b, matchId, roundId } = await start(t);
	await t.mutation(internal.ops.setCaps, {
		maxInFlight: 1,
		dailySecondsCap: 120,
		monthlySecondsCap: 120,
		monthlyActionSecondsCap: 135
	});
	await t.mutation(internal.ops.setJudging, { enabled: true });
	await a.mutation(api.submissions.submit, {
		roundId,
		source: 'immutable original source',
		clientSubmitId: 'original'
	});
	const [first] = await t.mutation(internal.judge._pump, {});
	const original = await t.mutation(internal.judge._claim, first);
	await t.mutation(internal.judge._beginCreate, first);
	await t.mutation(internal.judge._noteSandbox, { ...first, sandboxId });
	await t.mutation(internal.judge._noteContestantStart, { ...first, stage: 'run' });
	vi.setSystemTime(Date.now() + 1000);
	await b.mutation(api.submissions.submit, { roundId, source: 'rival', clientSubmitId: 'rival' });
	await t.mutation(internal.judge._fail, {
		...first,
		code: 'EXEC_LOST',
		failureClass: 'platform',
		timedOut: true
	});
	expect(await t.mutation(internal.judge._pump, {})).toEqual([]);
	await t.action(internal.judgeController._terminate, { sandboxId, lease: first });
	const [retry] = await t.mutation(internal.judge._pump, {});
	expect(retry.attemptId).not.toBe(first.attemptId);
	// Same source, exact source/test/environment hashes, limits, and original ceiling.
	expect(await t.mutation(internal.judge._claim, retry)).toEqual(original);
	const retrySandbox = 'sb-abcdefghijklmnopqrstuv';
	await t.mutation(internal.judge._beginCreate, retry);
	await t.mutation(internal.judge._noteSandbox, { ...retry, sandboxId: retrySandbox });
	await t.mutation(internal.judge._noteContestantStart, { ...retry, stage: 'run' });
	await t.mutation(internal.judge._fail, {
		...retry,
		code: 'EXEC_LOST',
		failureClass: 'platform',
		timedOut: true
	});
	expect((await a.query(api.matches.view, { matchId })).ownSubmissions[0].status).toBe('pending');
	expect(await t.mutation(internal.judge._pump, {})).toEqual([]);
	await t.action(internal.judgeController._terminate, { sandboxId: retrySandbox, lease: retry });
	// Duplicate receipt must not charge another 40 seconds or consume another slot.
	await t.action(internal.judgeController._terminate, { sandboxId: retrySandbox, lease: retry });
	const rivalJobs = await t.mutation(internal.judge._pump, {});
	expect(rivalJobs).toHaveLength(1);
	const rival = rivalJobs[0];
	expect((await t.mutation(internal.judge._claim, rival))?.source).toBe('rival');
	await t.mutation(internal.judge._complete, {
		...rival,
		result: { verdict: 'AC', phase: 'hidden', sandboxSeconds: 2, actionSeconds: 3 }
	});
	const view = await a.query(api.matches.view, { matchId });
	expect(view.rounds[0].ownSubmissions[0]).toMatchObject({
		status: 'done',
		verdict: 'TLE',
		sandboxTerminated: true
	});
	expect(view.rounds[0].outcome).toBe('won');
	expect(view.rounds[0].winnerId).not.toBe(view.playerId);
});

it('rejects a create response after the original ceiling even when watchdog delivery is delayed', async () => {
	const { t, a, job, matchId, at } = await sampleGame();
	const creating = deferred<unknown>();
	const entered = deferred<void>();
	sdk.create = () => {
		entered.resolve();
		return creating.promise;
	};
	let executions = 0;
	sdk.exec = async () => {
		executions++;
		throw new Error('expired create must not execute');
	};
	const running = t.action(internal.judgeController._run, job);
	await entered.promise;
	// Deliver neither scheduled ceiling nor watchdog: the callback itself must fence authority.
	vi.setSystemTime(at + 91000);
	creating.resolve(undefined);
	await running;
	expect(executions).toBe(0);
	expect((await a.query(api.matches.view, { matchId })).ownSampleRuns[0].status).toBe(
		'judge_failed'
	);
});
