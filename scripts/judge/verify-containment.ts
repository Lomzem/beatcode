import { Effect } from 'effect';
import { OperatorError, operatorAsync, operatorSync } from '../problems/effects.ts';
import { gzipSync } from 'node:zlib';
// Explicitly opt-in, bounded Modal-only verification. No local native compiler/process execution.
import { readFileSync, writeFileSync } from 'node:fs';
import {
	judgeAttempt,
	readBoundedEffect,
	sha256,
	environmentBinding,
	type Claim,
	type Result,
	type SandboxProvider
} from '../../judge/controller.ts';
import { modalClient, modalProvider } from '../../judge/modal.ts';
import { containmentCases } from './containment-cases.ts';
import { reserve, record, reaper, validationApp, evidenceDir } from './validation-budget.ts';
import { resolve } from 'node:path';

const verify = Effect.scoped(
	Effect.gen(function* () {
		if (process.env.BEATCODE_ALLOW_CONTAINMENT !== 'reviewed')
			return yield* new OperatorError({
				message:
					'Review first; set BEATCODE_ALLOW_CONTAINMENT=reviewed only for authorized bounded validation'
			});
		const app = yield* operatorSync('VALIDATION_CONFIG', validationApp);
		const metadata = yield* operatorSync('IMAGE_METADATA_READ', () =>
			JSON.parse(readFileSync(process.argv[2] ?? 'judge/image.json', 'utf8'))
		);
		const env = { ...metadata, _id: 'validation', envId: 'containment', status: 'active' };
		const client = yield* Effect.acquireRelease(
			operatorSync('MODAL_CONFIG', modalClient),
			(client) => operatorSync('MODAL_CLOSE', () => client.close()).pipe(Effect.orDie)
		);
		const provider = modalProvider(client, app);
		const report: {
			name: string;
			verdict: string;
			expected: string;
			counters?: Result['metrics'];
			sandboxSeconds?: number;
			actionSeconds?: number;
			observations?: string[];
			trailerStatuses: string[];
			strictVlaRejected?: boolean;
			cleanupScheduled: boolean;
			runnerCounters: Record<string, number>[];
		}[] = [];
		// Sequential sandboxes, 40 s each, no retries. Compile/run source only in Modal.
		yield* Effect.gen(function* () {
			for (const probe of containmentCases.filter(
				(p) =>
					!process.env.BEATCODE_VALIDATION_PROBES ||
					process.env.BEATCODE_VALIDATION_PROBES.split(',').includes(p.name)
			)) {
				const strict = probe.profile === 'strict';
				const blob = strict
					? gzipSync(
							JSON.stringify({
								format: 'beatcode-tests/1',
								tests: [
									...probe.samples.map((s) => ({
										kind: 'sample',
										input: s.input,
										answer: s.output
									})),
									...Array.from({ length: 10 }, () => ({
										kind: 'secret',
										input: probe.samples[0].input,
										answer: probe.samples[0].output
									}))
								]
							})
						)
					: undefined;
				const testHash = blob ? sha256(blob) : '0'.repeat(64);
				const claim: Claim = {
					kind: strict ? 'scored' : 'sample',
					source: probe.source,
					snapshot: {
						profile: probe.profile ?? 'std',
						judgeEnvId: env._id,
						sourceSha256: sha256(probe.source),
						testsSha256: testHash,
						environmentSha256: environmentBinding(env)
					},
					testsSha256: testHash,
					environment: env,
					limits: { timeMs: 3000, memoryMiB: 256, outputKiB: 1024, aggregateMs: 15000 },
					samples: probe.samples.map((s) => ({ ...s })),
					ceilingAt: Date.now() + 45000
				};
				const row: (typeof report)[number] = {
					name: probe.name,
					verdict: 'missing',
					expected: probe.expected,
					cleanupScheduled: false,
					runnerCounters: [],
					trailerStatuses: []
				};
				const observedProvider: SandboxProvider = {
					async create(image, config) {
						reserve(probe.name);
						const sb = await provider.create(image, config),
							exec = sb.exec,
							terminate = sb.terminate;
						record({ event: 'created', label: probe.name, id: sb.id });
						let seeded = false;
						const controller = new AbortController();
						const owned = new Set<Promise<unknown>>();
						const dispatch = (argv: string[], timeout: number) =>
							Effect.suspend(() =>
								controller.signal.aborted
									? Effect.fail(new OperatorError({ message: 'PROBE_CANCELLED' }))
									: operatorAsync('PROBE_EXEC', () => exec(argv, timeout))
							);
						sb.terminate = async () => {
							// The controller can interrupt its Promise adapter independently. Revoke
							// dispatch authority and drain local fibers/reader scopes before termination.
							controller.abort();
							await Promise.allSettled([...owned]);
							await terminate();
						};
						sb.exec = (argv, timeout) => {
							const work = Effect.runPromise(
								Effect.gen(function* () {
									if (
										probe.name === 'per-attempt-disk-baseline' &&
										((argv[0] === '/opt/judge/runner' && argv[1] === 'run') ||
											(argv[0] === '/bin/sh' && argv[3] === 'beatcode-run' && argv[4] === 'run')) &&
										!seeded
									) {
										seeded = true;
										// Deliberately retain root-owned allocation after compilation. A reset quota baseline
										// would wrongly permit the contestant's next 40 MiB allocation.
										yield* Effect.gen(function* () {
											const p = yield* dispatch(
												[
													'/usr/bin/dd',
													'if=/dev/zero',
													'of=/work/quota-fixture',
													'bs=1048576',
													'count=240',
													'status=none'
												],
												3000
											);
											yield* operatorAsync('PROBE_SETUP', () => p.stdin.close());
											const [, , code] = yield* Effect.all(
												[
													readBoundedEffect(p.stdout, 4096),
													readBoundedEffect(p.stderr, 4096),
													operatorAsync('PROBE_SETUP', () => p.wait())
												],
												{ concurrency: 'unbounded' }
											);
											if (code !== 0) return yield* new OperatorError({ message: 'PROBE_SETUP' });
										}).pipe(Effect.timeout(3000));
									}
									const p = yield* dispatch(argv, timeout);
									if (
										argv[0] === '/opt/judge/runner' ||
										(argv[0] === '/bin/sh' && argv[3] === 'beatcode-run' && argv[4] === 'run')
									) {
										let text = '';
										p.stderr = p.stderr.pipeThrough(
											new TransformStream<Uint8Array, Uint8Array>({
												transform(chunk, c) {
													if (text.length + chunk.length > 4096)
														throw new Error('PROBE_COUNTER_CAP');
													text += Buffer.from(chunk).toString();
													c.enqueue(chunk);
												},
												flush() {
													const value = JSON.parse(text);
													const counters: Record<string, number> = {};
													for (const key of [
														'minAvailMb',
														'diskPeakMb',
														'diskBaseMb',
														'sweeps',
														'leftover',
														'maxrssKb',
														'wallMs',
														'cpuMs'
													]) {
														if (!Number.isFinite(value[key]))
															throw new Error('PROBE_COUNTER_MISSING');
														counters[key] = value[key];
													}
													row.runnerCounters.push(counters);
													row.trailerStatuses.push(String(value.status));
												}
											})
										);
									}
									return p;
								}),
								{ signal: controller.signal }
							);
							owned.add(work);
							void work.then(
								() => owned.delete(work),
								() => owned.delete(work)
							);
							return work;
						};
						return sb;
					}
				};
				yield* operatorAsync('CONTAINMENT_JUDGE_FAILED', () =>
					judgeAttempt(
						claim,
						blob,
						observedProvider,
						{
							async noteSandbox() {
								return true;
							},
							async noteStart() {
								return true;
							},
							async complete(result) {
								row.verdict = result.verdict;
								if (probe.name === 'strict-vla')
									row.strictVlaRejected =
										result.verdict === 'CE' &&
										/variable length array/i.test(result.diagnostics ?? '');
								row.counters = result.metrics;
								row.sandboxSeconds = result.sandboxSeconds;
								row.actionSeconds = result.actionSeconds;
								// Only known public fixture markers; never arbitrary contestant output.
								row.observations = result.sampleResults?.map((r) => {
									const marker = r.output.trim();
									return [
										'clean',
										'ipc-dirty',
										'ipc-creation-allowed',
										'ipc-child-allowed',
										'ipc-operation-allowed',
										'ipc-x32-allowed',
										'ipc-compat-allowed',
										'fork-failed',
										'binary-unprotected',
										'other-writable',
										'dirty',
										'denied',
										'forged',
										'locked',
										'writable',
										'done',
										'escaped',
										'blocked',
										'reachable'
									].includes(marker)
										? marker
										: r.verdict;
								});
							},
							async fail(failure) {
								row.verdict = failure.failureClass;
							},
							async retryTermination(id) {
								row.cleanupScheduled = true;
								await (await client.sandboxes.fromId(id)).terminate();
							}
						},
						'containment',
						probe.name
					)
				);
				if (row.runnerCounters.some((c) => c.diskBaseMb !== row.runnerCounters[0].diskBaseMb))
					row.verdict = 'disk_baseline_changed';
				const requiredStatus =
					probe.name === 'output-flood'
						? 'ole'
						: ['many-file-disk-growth', 'per-attempt-disk-baseline'].includes(probe.name)
							? 'disk'
							: probe.name === 'fork-bomb'
								? 'tle'
								: undefined;
				if (requiredStatus && row.trailerStatuses[1] !== requiredStatus)
					row.verdict = 'wrong_guard';
				if (probe.name === 'strict-vla' && !row.strictVlaRejected)
					row.verdict = 'wrong_compile_failure';
				if (row.runnerCounters.some((c) => c.leftover !== 0)) row.verdict = 'leftover_processes';
				report.push(row);
				writeFileSync(
					process.argv[3] ?? resolve(evidenceDir, 'containment-results.json'),
					JSON.stringify(report, null, 2) + '\n'
				);
			}
		}).pipe(
			Effect.ensuring(
				operatorAsync('CONTAINMENT_REAPER', () => reaper(client, 'containment')).pipe(Effect.orDie)
			)
		);
		// Public counters/categories only: no source, test input, contestant output, or SDK error text.
		writeFileSync(
			process.argv[3] ?? resolve(evidenceDir, 'containment-results.json'),
			JSON.stringify(report, null, 2) + '\n'
		);
		if (report.some((r) => !r.expected.split('|').includes(r.verdict) || r.cleanupScheduled))
			process.exitCode = 1;
	})
);

await Effect.runPromise(verify);
