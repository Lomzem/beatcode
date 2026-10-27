import type { FunctionArgs } from 'convex/server';
import { serializeReferences } from '../../shared/calibrationDeployment';
import { afterEach, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { convexTest } from 'convex-test';
import schema from '../../convex/schema';
import { internal } from '../../convex/_generated/api';
import { ALL_HISTORY_POLICY_SPEC } from '../../convex/game/validators';
import { sha256 } from '../../judge/controller';

const sdk = vi.hoisted(() => ({
	mode: 'lost',
	appId: 'ap-1234567890123456789012',
	entered: () => {},
	terminating: () => {},
	alive: false,
	wallMs: 1,
	walls: [] as number[],
	hold: false,
	createLost: false,
	discover: false,
	tags: {} as Record<string, string>,
	terminations: 0
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
		apps = { fromName: async () => ({ appId: sdk.appId }) };
		images = { fromId: async () => ({}) };
		sandboxes = {
			fromId: async () => ({
				getTags: async () => sdk.tags,
				terminate: async () => {
					if (sdk.hold) throw new Error('fixture cleanup');
					sdk.terminations++;
					sdk.alive = false;
				},
				poll: async () => 0
			}),
			list: async function* () {
				if (sdk.discover)
					yield { sandboxId: 'sb-1234567890123456789012', getTags: async () => sdk.tags };
			},
			create: async (_app: unknown, _image: unknown, config: { tags: Record<string, string> }) => {
				sdk.tags = config.tags;
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
async function fixture(
	production = false,
	publicTimeMs = 500,
	acceptedCount = 1,
	origin: 'named' | 'legacy-absent' | 'legacy-null' = 'named'
) {
	vi.useFakeTimers();
	vi.stubEnv('CONVEX_DEPLOYMENT', 'dev:descriptive-scorpion-877');
	vi.stubEnv(
		'CONVEX_CLOUD_URL',
		production
			? 'https://careful-greyhound-596.convex.cloud'
			: 'https://descriptive-scorpion-877.convex.cloud'
	);
	if (production) vi.stubEnv('CONVEX_DEPLOYMENT', 'prod:careful-greyhound-596');
	vi.stubEnv(
		'MODAL_APP_NAME',
		production ? 'beatcode-calibration-prod-20261023-r1' : 'beatcode-calibration-dev-fixture'
	);
	vi.stubEnv('MODAL_SANDBOX_V2', '0');
	const t = convexTest(schema, modules);
	const { judgeEnvId } = await t.mutation(internal.problems._registerEnvironment, {
		...(production
			? {
					productionApp: {
						appName: 'beatcode-calibration-prod-20261023-r1' as const,
						appId: 'ap-1234567890123456789012'
					}
				}
			: {}),
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
	const referenceSolutions = {
		accepted: Array<string>(acceptedCount).fill('int main(){}'),
		timeLimitExceeded: ['int main(){}'],
		wrongAnswer: ['int main(){}'],
		validator: 'int main(){}'
	};
	const { problemVersionId } = await t.mutation(internal.problems._createVersion, {
		...(production
			? {
					productionBaseline: {
						originDeployment: 'dev:descriptive-scorpion-877' as const,
						...(origin === 'named'
							? {
									originPolicy: 'alpha-complexity-all-history-v1' as const,
									decisionPolicySha256: sha256(ALL_HISTORY_POLICY_SPEC)
								}
							: {
									originPolicy: 'legacy-fixed-spread-v1' as const,
									...(origin === 'legacy-null' ? { decisionPolicySha256: null } : {})
								}),
						originVersionId: 'original-dev-version',
						originVersion: 1,
						publicTimeMs,
						packageSha256: sha256('package'),
						testsSha256: sha256(blob),
						referencesSha256: sha256(serializeReferences(referenceSolutions)),
						evidenceSha256: sha256('dev-evidence')
					}
				}
			: {}),
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
		referenceSolutions
	});
	return {
		t,
		job: {
			problemVersionId,
			role: 'timeLimitExceeded' as const,
			index: 0,
			repeat: 0,
			...(production ? { decisionPolicy: 'alpha-complexity-all-history-v1' as const } : {})
		}
	};
}
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	sdk.entered = () => {};
	sdk.terminating = () => {};
	sdk.hold = false;
	sdk.createLost = false;
	sdk.discover = false;
	sdk.tags = {};
	sdk.terminations = 0;
	sdk.wallMs = 1;
	sdk.walls = [];
	sdk.appId = 'ap-1234567890123456789012';
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

it('executes the approved production target with a separate campaign allowance', async () => {
	const { t, job } = await fixture(true);
	vi.stubEnv('CONVEX_CLOUD_URL', 'https://careful-greyhound-596.convex.cloud');
	vi.stubEnv('CONVEX_DEPLOYMENT', 'prod:careful-greyhound-596');
	vi.stubEnv('MODAL_APP_NAME', 'beatcode-calibration-prod-20261023-r1');
	sdk.mode = 'AC';
	const result = await t.action(internal.calibration._job, job);
	expect(result.verdict).toBe('AC');
	expect(await t.query(internal.calibrationState._status, {})).toMatchObject({
		campaign: 'calibration-prod-20261023-v1',
		maxJobs: 150,
		maxSeconds: 6000,
		reservedSeconds: 40,
		pending: 0
	});
});

it.each([
	['PASSED', 1000, 268, 10001, true, 700, 700, null, 'named'],
	['PHASE6_AC_MARGIN', 500, 268, 10001, false, 3000, 700, null, 'named'],
	['PHASE6_SLOW_MARGIN', 3000, 31, 2000, false, 3000, 500, null, 'named'],
	['ADR3_FAILED', 1000, 268, 1749, false, 3000, 700, null, 'named'],
	['ADR3_FAILED', 1000, 268, 10001, false, 3000, 700, 'validator', 'named'],
	['ADR3_FAILED', 1000, 268, 10001, false, 3000, 700, 'slowSample', 'named'],
	['ADR3_FAILED', 1000, 268, 10001, false, 3000, 700, 'wrongAnswer', 'named'],
	['PASSED', 1000, 268, 10001, true, 700, 700, null, 'legacy-absent'],
	['PASSED', 1000, 268, 10001, true, 700, 700, null, 'legacy-null']
] as const)(
	'production finalization %s: DEV%s AC%s slow%s active%s public%s selected%s corrupt%s origin%s',
	async (outcome, devLimit, ac, slow, activated, publicLimit, selectedTimeMs, corrupt, origin) => {
		const { t, job } = await fixture(true, devLimit, 1, origin);
		const baseline = (await t.run((ctx) => ctx.db.get(job.problemVersionId)))!.productionBaseline;
		for (const index of [0, 1]) {
			sdk.mode = 'validator';
			await t.action(internal.calibration._job, { ...job, role: 'validator', index });
		}
		sdk.mode = 'AC';
		sdk.wallMs = 1;
		await t.action(internal.calibration._job, { ...job, role: 'slowSample' });
		for (let repeat = 0; repeat < 8; repeat++) {
			sdk.mode = 'AC';
			sdk.wallMs = ac;
			await t.action(internal.calibration._job, { ...job, role: 'accepted', repeat });
			sdk.mode = slow === 10001 ? 'TLE' : 'AC';
			if (slow !== 10001) sdk.walls = [slow, ...Array(10).fill(1)];
			await t.action(internal.calibration._job, { ...job, role: 'timeLimitExceeded', repeat });
		}
		sdk.mode = 'WA';
		await t.action(internal.calibration._job, { ...job, role: 'wrongAnswer' });
		if (corrupt) {
			const target = (await t.query(internal.calibrationState._status, {})).jobs.find(
				(j) => j.role === corrupt
			)!;
			await t.run(async (ctx) => {
				const row = (await ctx.db.get(target.reservationId))!;
				const entry = JSON.parse(row.detail);
				entry.result.execObservedMs = [];
				await ctx.db.patch(row._id, { detail: JSON.stringify(entry) });
			});
		}
		await expect(
			t.action(internal.calibration._finalize, {
				problemVersionId: job.problemVersionId,
				decisionPolicy: 'alpha-complexity-all-history-v1'
			})
		).rejects.toThrow('PRODUCTION_PHASE6_REQUIRED');
		expect(
			await t.action(internal.calibration._finalizeProduction, {
				problemVersionId: job.problemVersionId
			})
		).toMatchObject({ activated });
		const version = (await t.run((ctx) => ctx.db.get(job.problemVersionId)))!;
		expect(version).toMatchObject({
			status: activated ? 'active' : 'rejected',
			productionBaseline: baseline,
			limits: { timeMs: publicLimit },
			productionDecision: {
				name: 'production-phase6-all-history-v1',
				outcome,
				selectedTimeMs
			}
		});
		expect(version.productionBaseline!.originPolicy).toBe(
			origin === 'named' ? 'alpha-complexity-all-history-v1' : 'legacy-fixed-spread-v1'
		);
		if (origin === 'legacy-absent')
			expect(Object.hasOwn(version.productionBaseline!, 'decisionPolicySha256')).toBe(false);
		else if (origin === 'legacy-null')
			expect(version.productionBaseline!.decisionPolicySha256).toBeNull();
		else
			expect(version.productionBaseline!.decisionPolicySha256).toBe(
				'd4e0591e44e994a16dd9ad19166349132f963dd39a64688b5509acb2e1b072ca'
			);
		const decisions = await t.run((ctx) => ctx.db.query('auditLog').collect());
		const decision = JSON.parse(
			decisions.find((r) => r.kind === 'calibration-decision-production-phase6-all-history-v1')!
				.detail
		);
		expect(decision).toMatchObject({
			productionBaseline: baseline,
			productionDecision: { outcome },
			activated,
			priorStatus: 'draft'
		});
	}
);

it.each([
	[
		'https://warmhearted-avocet-538.convex.cloud',
		'prod:careful-greyhound-596',
		'beatcode-calibration-prod-20261023-r1'
	],
	[
		'https://careful-greyhound-596.convex.cloud',
		'dev:descriptive-scorpion-877',
		'beatcode-calibration-prod-20261023-r1'
	],
	[
		'https://careful-greyhound-596.convex.cloud',
		'prod:careful-greyhound-596',
		'beatcode-calibration-prod-evil'
	],
	[
		'https://careful-greyhound-596.convex.cloud.evil.test',
		'prod:careful-greyhound-596',
		'beatcode-calibration-prod-20261023-r1'
	]
])('rejects non-approved target/app before reservation: %s %s %s', async (url, deployment, app) => {
	const { t, job } = await fixture(true);
	vi.stubEnv('CONVEX_CLOUD_URL', url);
	vi.stubEnv('CONVEX_DEPLOYMENT', deployment);
	vi.stubEnv('MODAL_APP_NAME', app);
	await expect(t.action(internal.calibration._job, job)).rejects.toThrow(
		'CALIBRATION_DEPLOYMENT_CONFIG'
	);
	expect(await t.run((ctx) => ctx.db.query('auditLog').collect())).toEqual([]);
});

it('rejects an app ID rebinding before remote sandbox creation', async () => {
	const { t, job } = await fixture(true);
	sdk.appId = 'ap-9999999999999999999999';
	await expect(t.action(internal.calibration._job, job)).rejects.toThrow('CALIBRATION_APP_BINDING');
	expect(await t.query(internal.calibrationState._status, {})).toMatchObject({
		reservedSeconds: 40,
		pending: 0,
		jobs: [{ creation: 'reserved', released: true, result: { verdict: 'ERROR' } }]
	});
});

it('keeps the original DEV ledger unchanged when selecting the separate production namespace', async () => {
	const { t, job } = await fixture();
	sdk.mode = 'AC';
	await t.action(internal.calibration._job, job);
	const dev = await t.query(internal.calibrationState._status, {});
	expect(dev).toMatchObject({
		campaign: 'calibration-dev-20261023-v1',
		maxJobs: 250,
		maxSeconds: 10000,
		reservedSeconds: 40
	});
	vi.stubEnv('CONVEX_CLOUD_URL', 'https://careful-greyhound-596.convex.cloud');
	vi.stubEnv('CONVEX_DEPLOYMENT', 'prod:careful-greyhound-596');
	expect(await t.query(internal.calibrationState._status, {})).toMatchObject({
		campaign: 'calibration-prod-20261023-v1',
		maxJobs: 150,
		maxSeconds: 6000,
		reservedSeconds: 0,
		jobs: []
	});
	vi.stubEnv('CONVEX_CLOUD_URL', 'https://descriptive-scorpion-877.convex.cloud');
	vi.stubEnv('CONVEX_DEPLOYMENT', 'dev:descriptive-scorpion-877');
	expect(await t.query(internal.calibrationState._status, {})).toEqual(dev);
});

it('enforces the production 150-job cap through charged reservations without fabricated ledger rows', async () => {
	const { t, job } = await fixture(true, 500, 20);
	for (let n = 0; n < 150; n++) {
		const reservationId = await t.mutation(internal.calibrationState._reserve, {
			...job,
			role: 'accepted',
			index: Math.floor(n / 8),
			repeat: n % 8,
			sourceSha256: sha256('int main(){}')
		});
		await t.mutation(internal.calibrationState._finish, {
			reservationId,
			result: {
				verdict: 'ERROR',
				slowestTestMs: 0,
				aggregateMs: 0,
				attemptWallMs: 0,
				testWallMs: [],
				execObservedMs: [],
				sandboxSeconds: 40,
				actionSeconds: 0,
				sourceSha256: sha256('int main(){}'),
				executionTestsSha256: sha256('unused-before-create')
			}
		});
	}
	expect(await t.query(internal.calibrationState._status, {})).toMatchObject({
		reservedSeconds: 6000,
		pending: 0,
		sharedInFlight: 0
	});
	await expect(
		t.mutation(internal.calibrationState._reserve, {
			...job,
			role: 'accepted',
			index: 18,
			repeat: 6,
			sourceSha256: sha256('int main(){}')
		})
	).rejects.toThrow('CALIBRATION_CAPACITY');
	expect(await t.run((ctx) => ctx.db.query('usageMonthly').unique())).toMatchObject({
		actualSeconds: 6000,
		reservedSeconds: 0
	});
});

it.each(['draft', 'active', 'calibrating', 'rejected'] as const)(
	'rejects immutable payload drift and accepts identical re-uploads for %s version replay',
	async (status) => {
		const { t, job } = await fixture();
		const p = (await t.run((ctx) => ctx.db.get(job.problemVersionId)))!;
		const args: FunctionArgs<typeof internal.problems._createVersion> = {
			slug: 'fixture',
			title: 'Fixture',
			difficulty: 1,
			version: p.version,
			statementMd: p.statementMd,
			samples: p.samples,
			limits: p.limits,
			testsStorageId: p.testsStorageId,
			testsSha256: p.testsSha256,
			packageSha256: p.packageSha256,
			judgeEnvId: p.judgeEnvId,
			referenceSolutions: p.referenceSolutions!
		};
		// Persisted lifecycle fixtures only, not calibration measurements or receipts.
		await t.run((ctx) =>
			ctx.db.patch(job.problemVersionId, {
				status,
				limits: { ...p.limits, timeMs: status === 'draft' ? 3000 : 700 }
			})
		);
		const drift = [
			{ statementMd: 'Changed statement' },
			{ samples: [{ input: '2', output: '1' }] },
			{ samples: [{ input: '1', output: '2' }] },
			{ samples: [...args.samples, { input: '2', output: '2' }] },
			...(['accepted', 'timeLimitExceeded', 'wrongAnswer', 'validator'] as const).map((role) => ({
				referenceSolutions: {
					...args.referenceSolutions,
					[role]: role === 'validator' ? 'changed validator' : ['changed reference']
				}
			})),
			{ limits: { ...args.limits, memoryMiB: 512 } },
			{ limits: { ...args.limits, outputKiB: 2 } },
			{ limits: { ...args.limits, aggregateMs: 10000 } },
			...(status === 'draft' ? [{ limits: { ...args.limits, timeMs: 2000 } }] : [])
		];
		for (const changed of drift)
			await expect(
				t.mutation(internal.problems._createVersion, { ...args, ...changed })
			).rejects.toThrow('BAD_INPUT');
		const uploadedAgain = await t.run(async (ctx) =>
			ctx.storage.store((await ctx.storage.get(p.testsStorageId))!)
		);
		expect(
			await t.mutation(internal.problems._createVersion, {
				...args,
				testsStorageId: uploadedAgain
			})
		).toEqual({ problemVersionId: job.problemVersionId });
	}
);

it.each([
	'missing',
	'tests',
	'references',
	'replace',
	'named-missing-policy',
	'named-wrong-policy',
	'legacy-fake-policy'
] as const)(
	'refuses %s production baseline on trusted create without mutating the original binding',
	async (scenario) => {
		const { t, job } = await fixture(true);
		const p = (await t.run((ctx) => ctx.db.get(job.problemVersionId)))!;
		const baseline = p.productionBaseline!;
		const b =
			scenario === 'missing'
				? undefined
				: {
						...baseline,
						...(scenario === 'tests'
							? { testsSha256: 'f'.repeat(64) }
							: scenario === 'references'
								? { referencesSha256: 'f'.repeat(64) }
								: { publicTimeMs: 1000 })
					};
		const submitted = b as unknown as Record<string, unknown> | undefined;
		if (scenario === 'named-missing-policy') delete submitted!.decisionPolicySha256;
		if (scenario === 'named-wrong-policy') submitted!.decisionPolicySha256 = 'f'.repeat(64);
		if (scenario === 'legacy-fake-policy') submitted!.originPolicy = 'legacy-fixed-spread-v1';
		await expect(
			t.mutation(internal.problems._createVersion, {
				slug: 'fixture',
				title: 'Fixture',
				difficulty: 1,
				version: p.version,
				statementMd: p.statementMd,
				samples: p.samples,
				limits: p.limits,
				testsStorageId: p.testsStorageId,
				testsSha256: p.testsSha256,
				packageSha256: p.packageSha256,
				judgeEnvId: p.judgeEnvId,
				referenceSolutions: p.referenceSolutions!,
				...(submitted ? { productionBaseline: submitted } : {})
			} as unknown as FunctionArgs<typeof internal.problems._createVersion>)
		).rejects.toThrow();
		expect((await t.run((ctx) => ctx.db.get(job.problemVersionId)))!.productionBaseline).toEqual(
			baseline
		);
	}
);

it.each(['empty', 'app', 'deployment', 'attemptId', 'calibrationAppId'] as const)(
	'holds production unknown creation on %s discovery, then cleans only its bound sandbox',
	async (mismatch) => {
		const { t, job } = await fixture(true);
		sdk.createLost = true;
		expect(await t.action(internal.calibration._job, job)).toMatchObject({ verdict: 'ERROR' });
		const receipt = (await t.query(internal.calibrationState._status, {})).jobs[0];
		const actualTags = { ...sdk.tags };
		vi.setSystemTime(Date.now() + 600001);
		sdk.discover = mismatch !== 'empty';
		if (mismatch !== 'empty') sdk.tags[mismatch] = 'foreign';
		await t.action(internal.calibration._reconcile, { reservationId: receipt.reservationId });
		expect(await t.query(internal.calibrationState._status, {})).toMatchObject({
			pending: 1,
			sharedInFlight: 1,
			reservedSeconds: 40,
			jobs: [{ creation: 'creating', released: false }]
		});
		expect(sdk.terminations).toBe(0);
		sdk.discover = true;
		sdk.tags = actualTags;
		await t.action(internal.calibration._reconcile, { reservationId: receipt.reservationId });
		expect(await t.query(internal.calibrationState._status, {})).toMatchObject({
			pending: 0,
			sharedInFlight: 0,
			reservedSeconds: 40,
			jobs: [{ creation: 'stopped', released: true, expired: true }]
		});
		expect(sdk.terminations).toBe(1);
	}
);
