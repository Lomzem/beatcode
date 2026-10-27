import { afterEach, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import schema from '../../convex/schema';
import { internal } from '../../convex/_generated/api';
import { sha256 } from '../../judge/controller';

// The SDK is faked; the real action, adapter, judge preflight/checker, and ledger run.
// This oracle recognizes a fixed valid corpus. The first test also compiles and
// executes the generated wrapper locally, independently of the SDK oracle.
const sdk = vi.hoisted(() => ({
	measurement: false,
	createGate: undefined as Promise<void> | undefined,
	createStarted: undefined as (() => void) | undefined,
	failTerminate: false,
	discover: false,
	tags: {} as Record<string, string>,
	slowWallMs: 6000,
	valid: new Set<string>(),
	attempts: [] as { source: string; inputs: string[]; terminated: boolean }[]
}));
vi.mock('modal', () => ({
	ModalClient: class {
		profile = { tokenId: 'fake', tokenSecret: 'fake', sandboxV2: false };
		close() {}
		apps = { fromName: async () => ({}) };
		images = { fromId: async () => ({}) };
		sandboxes = {
			fromId: async () => ({
				getTags: async () => sdk.tags,
				terminate: async () => {
					if (sdk.failTerminate) throw new Error('fixture cleanup failed');
				},
				poll: async () => 0
			}),
			list: async function* () {
				if (sdk.discover)
					yield { sandboxId: 'sb-1234567890123456789012', getTags: async () => sdk.tags };
			},
			create: async (_app: unknown, _image: unknown, config: { tags: Record<string, string> }) => {
				sdk.tags = config.tags;
				sdk.createStarted?.();
				await sdk.createGate;
				const attempt = { source: '', inputs: [] as string[], terminated: false };
				sdk.attempts.push(attempt);
				return {
					sandboxId: 'sb-1234567890123456789012',
					terminate: async () => {
						if (sdk.failTerminate) throw new Error('fixture cleanup failed');
						attempt.terminated = true;
					},
					poll: async () => 0,
					exec: async (argv: string[]) => {
						let finish!: (s: string) => void;
						const body = new Promise<string>((resolve) => {
							finish = resolve;
						});
						const stream = (value: Promise<string>) =>
							new ReadableStream<Uint8Array>({
								async start(c) {
									c.enqueue(Buffer.from(await value));
									c.close();
								}
							});
						const chunks: Uint8Array[] = [];
						const hashCheck = argv[0] === '/usr/bin/sha256sum';
						const compile = argv[1] === 'compile';
						let wallMs = 1;
						let status = 'ok';
						if (hashCheck) finish(`${'a'.repeat(64)}  /opt/judge/runner\n`);
						return {
							stdin: new WritableStream<Uint8Array>({
								write(chunk) {
									chunks.push(chunk);
								},
								close() {
									const input = Buffer.concat(chunks).toString();
									if (compile) attempt.source = input;
									else if (!hashCheck) attempt.inputs.push(input);
									if (sdk.measurement && !hashCheck) {
										const requested =
											input === 'SLOW_TEST'
												? attempt.source.includes('slow fixture')
													? sdk.slowWallMs
													: 600
												: 1;
										const cap = compile ? 14000 : Number(argv[5]);
										wallMs = Math.min(requested, cap);
										status = requested > cap ? 'tle' : 'ok';
										vi.setSystemTime(Date.now() + wallMs);
									}
									finish(
										hashCheck
											? `${'a'.repeat(64)}  /opt/judge/runner\n`
											: compile
												? ''
												: sdk.valid.has(input) && !attempt.source.includes('wrong fixture')
													? 'VALID'
													: 'INVALID'
									);
								}
							}),
							stdout: stream(body),
							stderr: stream(
								body.then(() =>
									hashCheck
										? ''
										: JSON.stringify({
												status,
												wallMs,
												cpuMs: 1,
												minAvailMb: 400,
												diskBaseMb: 12,
												leftover: 0
											})
								)
							),
							wait: async () => 0
						};
					}
				};
			}
		};
	}
}));
const modules = import.meta.glob('../../convex/**/*.ts');
afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
	sdk.attempts.length = 0;
	sdk.valid.clear();
	sdk.measurement = false;
	sdk.createGate = undefined;
	sdk.createStarted = undefined;
	sdk.failTerminate = false;
	sdk.discover = false;
	sdk.tags = {};
	sdk.slowWallMs = 6000;
});

it('validates all 3 samples and 50 secrets plus malformed controls in two bounded jobs (SDK fake and local C++ wrapper)', async () => {
	vi.useFakeTimers();
	vi.stubEnv('CONVEX_DEPLOYMENT', 'dev:descriptive-scorpion-877');
	vi.stubEnv('CONVEX_CLOUD_URL', 'https://descriptive-scorpion-877.convex.cloud');
	vi.stubEnv('MODAL_APP_NAME', 'beatcode-calibration-dev-fixture');
	vi.stubEnv('MODAL_SANDBOX_V2', '0');
	const t = convexTest(schema, modules);
	const samples = ['2\n7 8\n', '1\n9\n', '3\n4 5 6\n'];
	const secrets = Array.from({ length: 50 }, (_, i) => `2\n100 ${i}\n`);
	for (const input of [...samples, ...secrets]) sdk.valid.add(input);
	const originalTests = [
		...samples.map((input) => ({ kind: 'sample', input, answer: 'VALID' })),
		...secrets.map((input) => ({ kind: 'secret', input, answer: 'VALID' }))
	];
	const blob = gzipSync(JSON.stringify({ format: 'beatcode-tests/1', tests: originalTests }));
	// Deliberately omits iostream: the wrapper owns its output dependency.
	const validator = `#include <cstdio>
int main(){
  int n, value;
  if(std::scanf("%d", &n)!=1 || n<=0) return 1;
  while(n--) if(std::scanf("%d", &value)!=1) return 1;
  char extra;
  return std::scanf(" %c", &extra)==EOF ? 42 : 1;
}`;
	const { judgeEnvId } = await t.mutation(internal.problems._registerEnvironment, {
		envId: 'sdk-fixture-staged-input',
		modalImageId: 'im-fixture',
		baseDigest: 'sha256:eb5e64286ad47187b32bda75c6b6916166ecb41da56559b8b09e0001748d2cce',
		gccVersion: '15.3.0',
		runtime: 'gvisor',
		cpu: 1,
		runnerSha256: 'a'.repeat(64)
	});
	const testsStorageId = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(blob)])));
	const versionArgs = {
		slug: 'validator-boundary',
		title: 'Validator boundary',
		difficulty: 1 as const,
		version: 1,
		statementMd: 'Fixture',
		samples: samples.map((input) => ({ input, output: 'VALID' })),
		limits: { timeMs: 3000, memoryMiB: 256, outputKiB: 1, aggregateMs: 15000 },
		testsStorageId,
		testsSha256: sha256(blob),
		packageSha256: sha256('boundary package'),
		judgeEnvId,
		referenceSolutions: {
			accepted: [validator],
			timeLimitExceeded: [validator],
			wrongAnswer: [validator],
			validator
		}
	};
	const { problemVersionId } = await t.mutation(internal.problems._createVersion, versionArgs);
	const job = { problemVersionId, role: 'validator' as const, repeat: 0 };
	for (const invalid of [
		{ index: 2, repeat: 0 },
		{ index: 0, repeat: 1 }
	]) {
		await expect(
			t.mutation(internal.calibrationState._reserve, {
				...job,
				...invalid,
				sourceSha256: sha256(validator)
			})
		).rejects.toThrow('CALIBRATION_JOB');
	}
	const first = await t.action(internal.calibration._job, { ...job, index: 0 });
	expect(first.verdict, JSON.stringify({ first, attempts: sdk.attempts })).toBe('AC');
	const dir = mkdtempSync(join(tmpdir(), 'beatcode-validator-wrapper-'));
	try {
		const binary = join(dir, 'validator');
		execFileSync('g++', ['-x', 'c++', '-std=gnu++20', '-O2', '-o', binary, '-'], {
			input: sdk.attempts[0].source,
			timeout: 15000
		});
		for (const [input, output] of [
			[samples[0], 'VALID'],
			['', 'INVALID']
		]) {
			expect(execFileSync(binary, [], { input, encoding: 'utf8', timeout: 1000 })).toBe(output);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	const second = await t.action(internal.calibration._job, { ...job, index: 1 });
	expect(second.verdict).toBe('AC');
	expect(sdk.attempts.map((a) => a.inputs)).toEqual([
		[...samples, ...secrets],
		[
			...samples,
			'',
			'2 7',
			'2\n7 8\n\nTRAILING_INVALID\n',
			'0 7 8',
			...Array<string>(6).fill(samples[0])
		]
	]);
	expect(sdk.attempts.every((a) => a.terminated)).toBe(true);
	const status = await t.query(internal.calibrationState._status, {});
	expect(status).toMatchObject({ reservedSeconds: 80, pending: 0 });
	expect(status.jobs).toHaveLength(2);
	for (const [index, result] of [first, second].entries()) {
		const executionTests =
			index === 0
				? originalTests.map((test) => ({ ...test, answer: 'VALID' }))
				: [
						...originalTests.slice(0, 3).map((test) => ({ ...test, answer: 'VALID' })),
						...['', '2 7', '2\n7 8\n\nTRAILING_INVALID\n', '0 7 8'].map((input, i) => ({
							name: `control-${i}`,
							input,
							answer: 'INVALID',
							kind: 'secret'
						})),
						...Array.from({ length: 6 }, (_, i) => ({
							name: `valid-${i}`,
							input: samples[0],
							answer: 'VALID',
							kind: 'secret'
						}))
					];
		expect(status.jobs[index]).toMatchObject({
			index,
			repeat: 0,
			role: 'validator',
			sourceSha256: sha256(validator),
			testsSha256: sha256(blob),
			packageSha256: sha256('boundary package'),
			released: true,
			result
		});
		expect(result.sourceSha256).toBe(sha256(sdk.attempts[index].source));
		expect(result.executionTestsSha256).toBe(
			sha256(gzipSync(JSON.stringify({ format: 'beatcode-tests/1', tests: executionTests })))
		);
		expect(result.testWallMs).toHaveLength(index === 0 ? 53 : 13);
	}
	await t.action(internal.calibration._job, {
		problemVersionId,
		role: 'slowSample',
		index: 0,
		repeat: 0
	});
	await expect(
		t.action(internal.calibration._finalize, { problemVersionId })
	).resolves.toMatchObject({ activated: false });
	const version = await t.run((ctx) => ctx.db.get(problemVersionId));
	expect(version?.calibration?.validatorPassed).toBe(true);
	// Missing timing/WA proof still prevents activation despite complete validator proof.
	expect(version?.status).toBe('rejected');

	for (const [offset, defect] of [
		'missing-control-job',
		'original-source',
		'execution-source',
		'execution-tests'
	].entries()) {
		const { problemVersionId: id } = await t.mutation(internal.problems._createVersion, {
			...versionArgs,
			version: offset + 2
		});
		await t.action(internal.calibration._job, {
			problemVersionId: id,
			role: 'validator',
			index: 0,
			repeat: 0
		});
		if (defect !== 'missing-control-job') {
			await t.action(internal.calibration._job, {
				problemVersionId: id,
				role: 'validator',
				index: 1,
				repeat: 0
			});
			// Inject corruption into a genuinely action-written fixture receipt. Never synthesize a result.
			const receipt = (await t.query(internal.calibrationState._status, {})).jobs.find(
				(j) => j.problemVersionId === id && j.role === 'validator' && j.index === 1
			)!;
			await t.run(async (ctx) => {
				const row = (await ctx.db.get(receipt.reservationId))!;
				const entry = JSON.parse(row.detail);
				if (defect === 'original-source') entry.sourceSha256 = 'f'.repeat(64);
				else if (defect === 'execution-source') entry.result.sourceSha256 = 'f'.repeat(64);
				else entry.result.executionTestsSha256 = 'f'.repeat(64);
				await ctx.db.patch(row._id, { detail: JSON.stringify(entry) });
			});
		}
		await t.action(internal.calibration._job, {
			problemVersionId: id,
			role: 'slowSample',
			index: 0,
			repeat: 0
		});
		await expect(
			t.action(internal.calibration._finalize, { problemVersionId: id })
		).resolves.toMatchObject({ activated: false });
		const rejected = await t.run((ctx) => ctx.db.get(id));
		expect(rejected?.calibration?.validatorPassed, defect).toBe(false);
	}
});

it.each([
	{
		slowWallMs: 6000,
		verdict: 'AC',
		measuredMs: 6000,
		walls: [1, 6000, ...Array<number>(9).fill(1)]
	},
	{ slowWallMs: 12000, verdict: 'TLE', measuredMs: 10000, walls: [1, 10000] }
])(
	'admits 600ms accepted and $slowWallMs ms slow-reference SDK fixtures with measured 10s censoring',
	async ({ slowWallMs, verdict, measuredMs, walls }) => {
		vi.useFakeTimers();
		vi.stubEnv('CONVEX_DEPLOYMENT', 'dev:descriptive-scorpion-877');
		vi.stubEnv('CONVEX_CLOUD_URL', 'https://descriptive-scorpion-877.convex.cloud');
		vi.stubEnv('MODAL_APP_NAME', 'beatcode-calibration-dev-fixture');
		vi.stubEnv('MODAL_SANDBOX_V2', '0');
		sdk.measurement = true;
		sdk.slowWallMs = slowWallMs;
		const t = convexTest(schema, modules);
		const inputs = ['PUBLIC', 'SLOW_TEST', ...Array.from({ length: 9 }, (_, i) => `SECRET_${i}`)];
		for (const input of inputs) sdk.valid.add(input);
		const blob = gzipSync(
			JSON.stringify({
				format: 'beatcode-tests/1',
				tests: inputs.map((input, i) => ({
					kind: i === 0 ? 'sample' : 'secret',
					input,
					answer: 'VALID'
				}))
			})
		);
		const { judgeEnvId } = await t.mutation(internal.problems._registerEnvironment, {
			envId: 'sdk-fixture-staged-input-calibration10s',
			modalImageId: 'im-fixture',
			baseDigest: 'sha256:eb5e64286ad47187b32bda75c6b6916166ecb41da56559b8b09e0001748d2cce',
			gccVersion: '15.3.0',
			runtime: 'gvisor',
			cpu: 1,
			runnerSha256: 'a'.repeat(64)
		});
		const testsStorageId = await t.run((ctx) =>
			ctx.storage.store(new Blob([new Uint8Array(blob)]))
		);
		const slow = 'int main(){} // slow fixture';
		const { problemVersionId } = await t.mutation(internal.problems._createVersion, {
			slug: 'measurement-boundary',
			title: 'Measurement boundary',
			difficulty: 1,
			version: 1,
			statementMd: 'Fixture',
			samples: [{ input: 'PUBLIC', output: 'VALID' }],
			limits: { timeMs: 3000, memoryMiB: 256, outputKiB: 1, aggregateMs: 15000 },
			testsStorageId,
			testsSha256: sha256(blob),
			packageSha256: sha256('measurement package'),
			judgeEnvId,
			referenceSolutions: {
				accepted: ['int main(){}'],
				timeLimitExceeded: [slow],
				wrongAnswer: ['int main(){} // wrong fixture'],
				validator: 'int main(){return 42;}'
			}
		});
		const run = (
			role: 'validator' | 'slowSample' | 'accepted' | 'timeLimitExceeded' | 'wrongAnswer',
			index = 0,
			repeat = 0
		) => t.action(internal.calibration._job, { problemVersionId, role, index, repeat });
		await run('validator');
		await run('validator', 1);
		await run('slowSample');
		for (let repeat = 0; repeat < 8; repeat++) {
			await run('accepted', 0, repeat);
			const measured = await run('timeLimitExceeded', 0, repeat);
			expect(measured).toMatchObject({
				verdict,
				slowestTestMs: measuredMs,
				aggregateMs: measuredMs + (verdict === 'AC' ? 10 : 1),
				sourceSha256: sha256(slow),
				executionTestsSha256: sha256(blob),
				testWallMs: walls,
				execObservedMs: walls
			});
		}
		await run('wrongAnswer');
		await expect(
			t.action(internal.calibration._finalize, { problemVersionId })
		).resolves.toMatchObject({ activated: true });
		const version = await t.run((ctx) => ctx.db.get(problemVersionId));
		expect(version?.limits.timeMs).toBe(1500);
		expect(version?.calibration?.timeLimitExceeded[0].slowestTestMs).toEqual(
			Array(8).fill(measuredMs)
		);
		expect(sdk.attempts.filter((a) => a.source === slow)).toHaveLength(9);
		expect(sdk.attempts.every((a) => a.terminated)).toBe(true);
		expect(await t.query(internal.calibrationState._status, {})).toMatchObject({
			reservedSeconds: 800,
			pending: 0
		});
	}
);

it.each(['lost', 'late'])(
	'holds capacity across %s create acknowledgement and late cleanup without expired results (SDK fake)',
	async (mode) => {
		vi.useFakeTimers();
		vi.stubEnv('CONVEX_DEPLOYMENT', 'dev:descriptive-scorpion-877');
		vi.stubEnv('CONVEX_CLOUD_URL', 'https://descriptive-scorpion-877.convex.cloud');
		vi.stubEnv('MODAL_APP_NAME', 'beatcode-calibration-dev-fixture');
		vi.stubEnv('MODAL_SANDBOX_V2', '0');
		const t = convexTest(schema, modules);
		const { judgeEnvId } = await t.mutation(internal.problems._registerEnvironment, {
			envId: 'cleanup-fixture',
			modalImageId: 'im-fixture',
			baseDigest: 'sha256:eb5e64286ad47187b32bda75c6b6916166ecb41da56559b8b09e0001748d2cce',
			gccVersion: '15.3.0',
			runtime: 'gvisor',
			cpu: 1,
			runnerSha256: 'a'.repeat(64)
		});
		const blob = gzipSync(
			JSON.stringify({
				format: 'beatcode-tests/1',
				tests: [
					{ kind: 'sample', input: '1', answer: 'VALID' },
					...Array.from({ length: 10 }, () => ({ kind: 'secret', input: '1', answer: 'VALID' }))
				]
			})
		);
		const testsStorageId = await t.run((ctx) =>
			ctx.storage.store(new Blob([new Uint8Array(blob)]))
		);
		const { problemVersionId } = await t.mutation(internal.problems._createVersion, {
			slug: 'cleanup-fixture',
			title: 'Cleanup',
			difficulty: 1,
			version: 1,
			statementMd: 'Fixture',
			samples: [{ input: '1', output: 'VALID' }],
			limits: { timeMs: 3000, memoryMiB: 256, outputKiB: 1, aggregateMs: 15000 },
			testsStorageId,
			testsSha256: sha256(blob),
			packageSha256: sha256('cleanup package'),
			judgeEnvId,
			referenceSolutions: {
				accepted: ['int main(){}'],
				timeLimitExceeded: ['int main(){}'],
				wrongAnswer: ['int main(){}'],
				validator: 'int main(){}'
			}
		});
		let resolveCreate!: () => void;
		let rejectCreate!: (e: Error) => void;
		let started!: () => void;
		const dispatch = new Promise<void>((resolve) => {
			started = resolve;
		});
		sdk.createStarted = started;
		sdk.createGate = new Promise<void>((resolve, reject) => {
			resolveCreate = resolve;
			rejectCreate = reject;
		});
		const job = t.action(internal.calibration._job, {
			problemVersionId,
			role: 'accepted',
			index: 0,
			repeat: 0
		});
		await dispatch;
		const receipt = (await t.query(internal.calibrationState._status, {})).jobs[0];
		vi.setSystemTime(Date.now() + 600001);
		await t.mutation(internal.calibrationState._expire, { reservationId: receipt.reservationId });
		expect(await t.query(internal.calibrationState._status, {})).toMatchObject({
			pending: 1,
			sharedInFlight: 1
		});
		if (mode === 'lost') {
			// The fake models a remote creation whose response is lost when the action dies.
			rejectCreate(new Error('fixture action/response lost'));
			await job.catch(() => undefined);
			await t.action(internal.calibration._reconcile, { reservationId: receipt.reservationId });
			expect(await t.query(internal.calibrationState._status, {})).toMatchObject({
				pending: 1,
				sharedInFlight: 1
			});
			sdk.discover = true;
			sdk.failTerminate = true;
			await t.action(internal.calibration._reconcile, { reservationId: receipt.reservationId });
		} else {
			sdk.failTerminate = true;
			resolveCreate();
			// Let controller finalization enter its lifetime wait, then advance it.
			await vi.advanceTimersByTimeAsync(41001);
			const expiredResult = await job;
			await t.mutation(internal.calibrationState._finish, {
				reservationId: receipt.reservationId,
				result: expiredResult
			});
		}
		sdk.failTerminate = true;
		await t.action(internal.calibration._cleanup, { reservationId: receipt.reservationId });
		expect(await t.query(internal.calibrationState._status, {})).toMatchObject({
			pending: 1,
			sharedInFlight: 1
		});
		sdk.failTerminate = false;
		await t.action(internal.calibration._cleanup, { reservationId: receipt.reservationId });
		const done = await t.query(internal.calibrationState._status, {});
		expect(done).toMatchObject({ pending: 0, sharedInFlight: 0, reservedSeconds: 40 });
		expect(done.jobs[0]).toMatchObject({ released: true, expired: true, creation: 'stopped' });
		expect(done.jobs[0].result).toBeUndefined();
		await t.mutation(internal.calibrationState._reserve, {
			problemVersionId,
			role: 'accepted',
			index: 0,
			repeat: 1,
			sourceSha256: sha256('int main(){}')
		});
		await expect(
			t.mutation(internal.calibrationState._created, {
				reservationId: receipt.reservationId,
				sandboxId: 'sb-1234567890123456789012'
			})
		).resolves.toBe(false);
		await t.mutation(internal.calibrationState._terminated, {
			reservationId: receipt.reservationId,
			sandboxId: 'sb-1234567890123456789012'
		});
		const afterStaleAck = await t.query(internal.calibrationState._status, {});
		expect(afterStaleAck).toMatchObject({ pending: 1, sharedInFlight: 1 });
		expect(afterStaleAck.jobs[0].result).toBeUndefined();
	}
);
