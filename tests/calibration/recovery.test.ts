import { afterEach, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { convexTest } from 'convex-test';
import schema from '../../convex/schema';
import { internal } from '../../convex/_generated/api';
import { sha256 } from '../../judge/controller';

const sdk = vi.hoisted(() => ({
	mode: 'lost',
	entered: () => {},
	terminating: () => {},
	alive: false,
	wallMs: 1,
	walls: [] as number[],
	hold: false,
	createLost: false
}));
function processReply(out: string | ((input: string) => string), status = 'ok', wallMs = 1) {
	const stream = (value: string) =>
		new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(Buffer.from(value));
				c.close();
			}
		});
	let input = '';
	let output!: ReadableStreamDefaultController<Uint8Array>;
	return {
		stdout:
			typeof out === 'string'
				? stream(out)
				: new ReadableStream<Uint8Array>({
						start(c) {
							output = c;
						}
					}),
		stderr: stream(
			JSON.stringify({ status, wallMs, cpuMs: 1, minAvailMb: 512, diskBaseMb: 0, leftover: 0 })
		),
		stdin: new WritableStream<Uint8Array>({
			write(chunk) {
				input += Buffer.from(chunk).toString();
			},
			close() {
				if (typeof out === 'function') {
					output.enqueue(Buffer.from(out(input)));
					output.close();
				}
			}
		}),
		wait: async () => 0
	};
}
vi.mock('modal', () => ({
	ModalClient: class {
		profile = { tokenId: 'fixture', tokenSecret: 'fixture', sandboxV2: false };
		close() {}
		apps = { fromName: async () => ({ appId: 'fixture' }) };
		images = { fromId: async () => ({}) };
		sandboxes = {
			create: async () => {
				if (sdk.createLost) throw new Error('PRIVATE_SOURCE_TOKEN');
				sdk.alive = true;
				return {
					sandboxId: 'sb-1234567890123456789012',
					terminate: async () => {
						sdk.terminating();
						if (sdk.hold) throw new Error('PRIVATE_SOURCE_TOKEN');
						sdk.alive = false;
					},
					poll: async () => (sdk.alive ? null : 0),
					exec: async (argv: string[]) => {
						vi.setSystemTime(Date.now() + 1);
						if (argv[0] === '/usr/bin/sha256sum') {
							if (sdk.mode === 'preflight') throw new Error('PRIVATE_SOURCE_TOKEN');
							return processReply('0'.repeat(64) + '  /opt/judge/runner');
						}
						if (argv[1] === 'compile') return processReply('', sdk.mode === 'CE' ? 're' : 'ok');
						sdk.entered();
						if (sdk.mode === 'timeout') return new Promise<never>(() => {});
						if (sdk.mode === 'lost') throw new Error('PRIVATE_SOURCE_TOKEN');
						if (sdk.mode === 'validator')
							return processReply((input) => (input.trim() === '1' ? 'VALID' : 'INVALID'));
						return sdk.mode === 'AC'
							? processReply('1', 'ok', sdk.walls.shift() ?? sdk.wallMs)
							: sdk.mode === 'WA'
								? processReply('0')
								: sdk.mode === 'RE'
									? processReply('', 're')
									: sdk.mode === 'MLE'
										? processReply('', 'mle')
										: sdk.mode === 'OLE'
											? processReply('', 'ole')
											: processReply('', 'tle', 10001);
					}
				};
			}
		};
	}
}));
const modules = import.meta.glob('../../convex/**/*.ts');
async function fixture() {
	vi.useFakeTimers();
	vi.stubEnv('CONVEX_DEPLOYMENT', 'dev:descriptive-scorpion-877');
	vi.stubEnv('MODAL_APP_NAME', 'beatcode-calibration-dev-fixture');
	vi.stubEnv('MODAL_SANDBOX_V2', '0');
	const t = convexTest(schema, modules);
	const { judgeEnvId } = await t.mutation(internal.problems._registerEnvironment, {
		envId: 'fixture',
		modalImageId: 'im-fixture',
		baseDigest: 'sha256:eb5e64286ad47187b32bda75c6b6916166ecb41da56559b8b09e0001748d2cce',
		gccVersion: '15.3.0',
		runtime: 'gvisor',
		cpu: 1,
		runnerSha256: '0'.repeat(64)
	});
	const blob = gzipSync(
		JSON.stringify({
			format: 'beatcode-tests/1',
			tests: Array.from({ length: 11 }, (_, i) => ({
				kind: i === 0 ? 'sample' : 'secret',
				input: '1',
				answer: '1'
			}))
		})
	);
	const testsStorageId = await t.run((ctx) => ctx.storage.store(new Blob([blob])));
	const { problemVersionId } = await t.mutation(internal.problems._createVersion, {
		slug: 'fixture',
		title: 'Fixture',
		difficulty: 1,
		version: 1,
		statementMd: 'Fixture',
		samples: [{ input: '1', output: '1' }],
		limits: { timeMs: 3000, memoryMiB: 256, outputKiB: 1, aggregateMs: 15000 },
		testsStorageId,
		testsSha256: sha256(blob),
		packageSha256: sha256('package'),
		judgeEnvId,
		referenceSolutions: {
			accepted: ['int main(){}'],
			timeLimitExceeded: ['int main(){}'],
			wrongAnswer: ['int main(){}'],
			validator: 'int main(){}'
		}
	});
	return { t, job: { problemVersionId, role: 'timeLimitExceeded' as const, index: 0, repeat: 0 } };
}
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	sdk.entered = () => {};
	sdk.terminating = () => {};
	sdk.hold = false;
	sdk.createLost = false;
	sdk.wallMs = 1;
	sdk.walls = [];
});
it.each([
	['lost', { failureClass: 'sandbox_lost', code: 'EXEC_LOST', timedOut: false, lowMemory: false }],
	[
		'timeout',
		{ failureClass: 'sandbox_lost', code: 'EXEC_LOST', timedOut: true, lowMemory: false }
	],
	['preflight', { failureClass: 'platform', code: 'CONTROLLER_PREFLIGHT' }]
] as const)(
	'retains sanitized %s diagnostics through the actual calibration action and controller',
	async (mode, failure) => {
		const { t, job } = await fixture();
		sdk.mode = mode;
		const entered = new Promise<void>((resolve) => {
			sdk.entered = resolve;
		});
		const running = t.action(internal.calibration._job, job);
		if (mode === 'timeout') {
			await entered;
			await vi.advanceTimersByTimeAsync(13001);
		}
		const result = await running;
		expect(result).toMatchObject({
			verdict: 'ERROR',
			testWallMs: [],
			execObservedMs: [],
			sandboxSeconds: 40,
			failure
		});
		const status = await t.query(internal.calibrationState._status, {});
		expect(status).toMatchObject({ pending: 0, sharedInFlight: 0, reservedSeconds: 40 });
		expect(status.jobs[0]).toMatchObject({ creation: 'stopped', released: true, result });
		expect(JSON.stringify(status)).not.toContain('PRIVATE_SOURCE_TOKEN');
	}
);

it('allows one explicit audited legacy rejudge of a stopped empty ERROR without erasing charges or retrying automatically', async () => {
	const { t, job } = await fixture();
	sdk.mode = 'lost';
	await t.action(internal.calibration._job, job);
	const id = (await t.query(internal.calibrationState._status, {})).jobs[0].reservationId;
	// Old deployed receipts omitted these optional fields; retain all real lifecycle/measurement fields.
	await t.run(async (ctx) => {
		const row = (await ctx.db.get(id))!;
		const legacy = JSON.parse(row.detail);
		delete legacy.failure;
		delete legacy.environmentSha256;
		delete legacy.result.failure;
		await ctx.db.patch(id, { detail: JSON.stringify(legacy) });
	});
	const primary = (await t.query(internal.calibrationState._status, {})).jobs[0];
	expect(primary.result?.failure).toBeUndefined();
	await expect(t.action(internal.calibration._job, { ...job, retryOf: id })).rejects.toThrow(
		'CALIBRATION_RETRY_NOT_ALLOWED'
	);
	const retry = {
		...job,
		retryOf: primary.reservationId,
		retryApproval: 'reviewed-empty-error-once' as const
	};
	sdk.mode = 'tle';
	const result = await t.action(internal.calibration._job, retry);
	expect(result).toMatchObject({ verdict: 'TLE', slowestTestMs: 10001, testWallMs: [10001] });
	expect(result.failure).toBeUndefined();
	const status = await t.query(internal.calibrationState._status, {});
	expect(status).toMatchObject({ reservedSeconds: 80, pending: 0, sharedInFlight: 0 });
	expect(status.jobs).toHaveLength(2);
	expect(status.jobs[0]).toEqual(primary);
	expect(status.jobs[1]).toMatchObject({
		retryOf: primary.reservationId,
		retryApproval: 'reviewed-empty-error-once',
		creation: 'stopped',
		released: true
	});
	await expect(t.action(internal.calibration._job, retry)).rejects.toThrow(
		'CALIBRATION_RETRY_NOT_ALLOWED'
	);
	await expect(
		t.action(internal.calibration._job, { ...retry, retryOf: status.jobs[1].reservationId })
	).rejects.toThrow('CALIBRATION_RETRY_NOT_ALLOWED');
	expect((await t.query(internal.calibrationState._status, {})).reservedSeconds).toBe(80);
});

it.each(['AC', 'TLE', 'WA', 'RE', 'CE', 'MLE', 'OLE'])(
	'refuses to replace a genuine %s measurement',
	async (verdict) => {
		const { t, job } = await fixture();
		sdk.mode = verdict;
		const result = await t.action(internal.calibration._job, job);
		expect(result.verdict).toBe(verdict);
		const primary = (await t.query(internal.calibrationState._status, {})).jobs[0];
		await expect(
			t.action(internal.calibration._job, {
				...job,
				retryOf: primary.reservationId,
				retryApproval: 'reviewed-empty-error-once'
			})
		).rejects.toThrow('CALIBRATION_RETRY_NOT_ALLOWED');
		expect((await t.query(internal.calibrationState._status, {})).reservedSeconds).toBe(40);
	}
);

it.each([
	'missing',
	'recovered',
	'second-spread',
	'all-history',
	'all-history-draft',
	'all-history-resume',
	'all-history-outlier',
	'all-history-aggregate',
	'all-history-attempt',
	'all-history-verdict',
	'all-history-short',
	'all-history-count',
	'all-history-source',
	'all-history-tests',
	'all-history-environment',
	'all-history-slow-close',
	'all-history-slow-RE',
	'all-history-slow-CE',
	'all-history-slow-MLE',
	'all-history-slow-OLE',
	'all-history-slow-WA',
	'all-history-slow-AC',
	'all-history-error',
	'all-history-held',
	'all-history-WA'
])('finalizes logical evidence under explicit or legacy policy: %s', async (scenario) => {
	const recover = scenario !== 'missing';
	const allHistory = scenario.startsWith('all-history');
	const { t, job } = await fixture();
	async function run(
		role: 'validator' | 'slowSample' | 'accepted' | 'timeLimitExceeded' | 'wrongAnswer',
		index: number,
		repeat: number,
		mode: string
	) {
		sdk.mode = mode;
		await t.action(internal.calibration._job, { ...job, role, index, repeat });
	}
	async function rejudge(mode: string) {
		const primary = (await t.query(internal.calibrationState._status, {})).jobs.at(-1)!;
		sdk.mode = mode;
		await t.action(internal.calibration._job, {
			...job,
			role: primary.role as typeof job.role,
			index: primary.index,
			repeat: primary.repeat,
			retryOf: primary.reservationId,
			retryApproval: 'reviewed-empty-error-once'
		});
	}
	await run('validator', 0, 0, 'lost');
	if (recover) await rejudge('validator');
	await run('validator', 1, 0, 'validator');
	await run('slowSample', 0, 0, 'AC');
	for (let r = 0; r < 8; r++) {
		sdk.wallMs = allHistory
			? r === 7
				? 268
				: 31
			: scenario === 'second-spread' && r === 7
				? 3
				: 1;
		await run('accepted', 0, r, 'AC');
	}
	if (scenario === 'second-spread' || allHistory) {
		for (let r = 8; r < (allHistory ? 15 : 16); r++) {
			sdk.wallMs = allHistory ? 69 : r === 15 ? 3 : 1;
			await run('accepted', 0, r, 'AC');
		}
	}
	for (let r = 0; r < 8; r++) {
		if (scenario === 'all-history-slow-AC' && r === 0) sdk.walls = [2000, ...Array(10).fill(1)];
		await run(
			'timeLimitExceeded',
			0,
			r,
			r === 7 ? 'lost' : scenario === 'all-history-slow-AC' && r === 0 ? 'AC' : 'TLE'
		);
	}
	if (recover) await rejudge('TLE');
	if (scenario !== 'all-history-resume') await run('wrongAnswer', 0, 0, 'WA');
	const result =
		scenario === 'all-history-draft'
			? { activated: false }
			: await t.action(internal.calibration._finalize, {
					problemVersionId: job.problemVersionId
				});
	expect(result.activated).toBe(scenario === 'recovered');
	const status = await t.query(internal.calibrationState._status, {});
	expect(status).toMatchObject({
		pending: 0,
		sharedInFlight: 0,
		reservedSeconds:
			scenario === 'all-history-resume'
				? 1120
				: allHistory
					? 1160
					: scenario === 'second-spread'
						? 1200
						: recover
							? 880
							: 800
	});
	expect(status.jobs.filter((j) => j.result?.verdict === 'ERROR')).toHaveLength(2);
	if (scenario === 'all-history-slow-AC')
		expect(
			status.jobs.find((j) => j.role === 'timeLimitExceeded' && j.repeat === 0)?.result
		).toMatchObject({ verdict: 'AC', slowestTestMs: 2000, aggregateMs: 2010 });
	if (allHistory) {
		const prior = await t.run((ctx) => ctx.db.get(job.problemVersionId));
		// Corrupt real persisted receipts; never fabricate reservation/charge ownership.
		const corruption = scenario.slice('all-history-'.length);
		if (
			scenario !== 'all-history' &&
			scenario !== 'all-history-draft' &&
			scenario !== 'all-history-resume' &&
			scenario !== 'all-history-slow-AC'
		) {
			await t.run(async (ctx) => {
				const target = status.jobs.find(
					(j) =>
						j.role ===
						(corruption.startsWith('slow-')
							? 'timeLimitExceeded'
							: corruption === 'WA'
								? 'wrongAnswer'
								: 'accepted')
				)!;
				const row = (await ctx.db.get(target.reservationId))!;
				const entry = JSON.parse(row.detail);
				const r = entry.result;
				if (corruption === 'outlier') {
					r.testWallMs[0] = 1201;
					r.slowestTestMs = 1201;
					r.aggregateMs = 1511;
				}
				if (corruption === 'aggregate') {
					r.testWallMs = Array(11).fill(700);
					r.slowestTestMs = 700;
					r.aggregateMs = 7700;
				}
				if (corruption === 'attempt') r.attemptWallMs = 15001;
				if (corruption === 'verdict') r.verdict = 'WA';
				if (corruption === 'short') {
					r.testWallMs = [31];
					r.execObservedMs = [1];
					r.aggregateMs = 31;
				}
				if (corruption === 'count') r.execObservedMs.pop();
				if (corruption === 'source') r.sourceSha256 = 'f'.repeat(64);
				if (corruption === 'tests') entry.testsSha256 = 'f'.repeat(64);
				if (corruption === 'environment') entry.environmentSha256 = 'f'.repeat(64);
				if (corruption === 'slow-close') {
					r.testWallMs = [1749];
					r.execObservedMs = [1749];
					r.slowestTestMs = 1749;
					r.aggregateMs = 1749;
				}
				if (['slow-RE', 'slow-CE', 'slow-MLE', 'slow-OLE', 'slow-WA'].includes(corruption))
					r.verdict = corruption.slice(5);
				if (corruption === 'error') {
					r.verdict = 'ERROR';
					r.testWallMs = [];
					r.execObservedMs = [];
					r.slowestTestMs = 0;
					r.aggregateMs = 0;
					r.attemptWallMs = 0;
				}
				if (corruption === 'held') {
					entry.released = false;
					entry.creation = 'known';
				}
				if (corruption === 'WA') r.verdict = 'AC';
				await ctx.db.patch(row._id, { detail: JSON.stringify(entry) });
			});
		}
		if (scenario === 'all-history-resume') {
			sdk.mode = 'WA';
			await t.action(internal.calibration._job, {
				...job,
				role: 'wrongAnswer',
				repeat: 0,
				decisionPolicy: 'alpha-complexity-all-history-v1'
			});
		}
		const running = t.action(internal.calibration._finalize, {
			problemVersionId: job.problemVersionId,
			decisionPolicy: 'alpha-complexity-all-history-v1'
		});
		if (['source', 'tests', 'environment', 'held'].includes(corruption)) {
			await expect(running).rejects.toThrow(
				corruption === 'environment'
					? 'CALIBRATION_ENVIRONMENT'
					: corruption === 'held'
						? 'CALIBRATION_PENDING'
						: corruption === 'tests'
							? 'CALIBRATION_TEST_BINDING'
							: 'CALIBRATION_EVIDENCE'
			);
			return;
		}
		const next = await running;
		const accepts =
			scenario === 'all-history' ||
			scenario === 'all-history-draft' ||
			scenario === 'all-history-resume' ||
			scenario === 'all-history-slow-AC';
		expect(next.activated).toBe(accepts);
		const current = await t.run((ctx) => ctx.db.get(job.problemVersionId));
		expect(current?.limits.timeMs).toBe(accepts ? 700 : 3000);
		expect(current?.calibration?.accepted[0].slowestTestMs).toHaveLength(15);
		const decisions = await t.run((ctx) => ctx.db.query('auditLog').collect());
		const decision = decisions.find(
			(r) => r.kind === 'calibration-decision-alpha-complexity-all-history-v1'
		);
		expect(JSON.parse(decision!.detail)).toMatchObject({
			priorStatus: prior?.status,
			priorCalibration: prior?.calibration ?? null,
			activated: accepts,
			accepted: [{ count: 15 }]
		});
		if (accepts && scenario !== 'all-history-resume')
			expect((await t.query(internal.calibrationState._status, {})).jobs).toEqual(status.jobs);
	}
});

it.each(['unknown', 'held'])(
	'keeps %s creation/cleanup charged and ineligible for rejudge',
	async (kind) => {
		const { t, job } = await fixture();
		sdk.mode = 'lost';
		sdk.createLost = kind === 'unknown';
		sdk.hold = kind === 'held';
		const terminating = new Promise<void>((resolve) => {
			sdk.terminating = resolve;
		});
		const running = t.action(internal.calibration._job, job);
		if (kind === 'held') {
			await terminating;
			await vi.advanceTimersByTimeAsync(41001);
		}
		await running;
		const status = await t.query(internal.calibrationState._status, {});
		expect(status).toMatchObject({ pending: 1, sharedInFlight: 1, reservedSeconds: 40 });
		const primary = status.jobs[0];
		expect(primary).toMatchObject({
			released: false,
			creation: kind === 'unknown' ? 'creating' : 'known',
			failure: { code: kind === 'unknown' ? 'CONTROLLER_PREFLIGHT' : 'EXEC_LOST' }
		});
		expect(primary.result).toBeUndefined();
		await expect(
			t.action(internal.calibration._job, {
				...job,
				retryOf: primary.reservationId,
				retryApproval: 'reviewed-empty-error-once'
			})
		).rejects.toThrow('CALIBRATION_RETRY_NOT_ALLOWED');
		if (kind === 'held') {
			sdk.hold = false;
			// The in-memory SDK owns no native resource; permit local fixture cleanup.
			sdk.alive = false;
		}
	}
);
