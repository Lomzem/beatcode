import { describe, expect, test, vi } from 'vitest';
import { compareTokens } from '../../judge/controller';

describe('trusted sandbox boundary', () => {
	test('token comparison ignores ASCII whitespace but preserves numbers and Unicode bytes', () => {
		expect(compareTokens(' 1\r\n2\t', '1 2')).toBe(true);
		expect(compareTokens('01 2', '1 2')).toBe(false);
		expect(compareTokens('é', 'e')).toBe(false);
		expect(compareTokens('a\u00a0b', 'a b')).toBe(false);
	});
});

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
	judgeAttempt,
	type Claim,
	type JudgeSink,
	type Process,
	type Result,
	type SandboxConfig,
	type SandboxProvider
} from '../../judge/controller';

function fixture(kind: 'scored' | 'sample' = 'sample') {
	const environment = {
		_id: 'env1',
		envId: 'test',
		modalImageId: 'im-fixture',
		baseDigest: 'sha256:eb5e64286ad47187b32bda75c6b6916166ecb41da56559b8b09e0001748d2cce',
		gccVersion: '15.3.0',
		runtime: 'gvisor',
		cpu: 1,
		runnerSha256: 'a'.repeat(64),
		status: 'active'
	};
	const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
	const blob = gzipSync(
		JSON.stringify({
			format: 'beatcode-tests/1',
			tests: [
				{ kind: 'sample', input: 'PUBLIC_INPUT', answer: 'PUBLIC_ANSWER' },
				...Array.from({ length: 10 }, (_, i) => ({
					kind: 'secret',
					input: `SECRET_INPUT_${i}`,
					answer: `SECRET_ANSWER_${i}`
				}))
			]
		})
	);
	const claim: Claim = {
		kind,
		source: 'OPAQUE_SOURCE',
		snapshot: {
			profile: 'std',
			judgeEnvId: 'env1',
			sourceSha256: hash('OPAQUE_SOURCE'),
			testsSha256: hash(blob),
			environmentSha256: hash(
				JSON.stringify([
					'test',
					'im-fixture',
					environment.baseDigest,
					'15.3.0',
					'gvisor',
					1,
					'a'.repeat(64)
				])
			)
		},
		environment,
		limits: { timeMs: 1000, memoryMiB: 256, outputKiB: 1, aggregateMs: 15000 },
		samples: [{ input: 'PUBLIC_INPUT', output: 'PUBLIC_ANSWER' }],
		testsSha256: hash(blob),
		ceilingAt: Date.now() + 90000
	};
	return { claim, blob };
}
function bytes(s: string) {
	return new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(Buffer.from(s));
			c.close();
		}
	});
}
function result(out: string, fields = {}) {
	return {
		out,
		err: JSON.stringify({
			status: 'ok',
			wallMs: 10,
			cpuMs: 5,
			minAvailMb: 400,
			diskBaseMb: 12,
			leftover: 0,
			...fields
		})
	};
}
// Independent sandbox transport protocol: only this trusted shell command stages a run.
function runnerArgs(argv: string[]) {
	if (argv[0] !== '/bin/sh') return argv;
	expect(argv.slice(0, 4)).toEqual([
		'/bin/sh',
		'-c',
		'set -eu; umask 077; rm -f -- /work/current-input; cat > /work/current-input; exec /opt/judge/runner "$@" < /work/current-input',
		'beatcode-run'
	]);
	return ['/opt/judge/runner', ...argv.slice(4)];
}
function boundary(replies: (ReturnType<typeof result> | Error)[]) {
	const receipts = {
		configs: [] as SandboxConfig[],
		inputs: [] as string[],
		terminated: 0,
		retried: [] as string[],
		completed: [] as Result[],
		failed: [] as Parameters<JudgeSink['fail']>[0][],
		stages: [] as string[]
	};
	let terminationError = false,
		leaseActive = true,
		id = 'sb-1234567890123456789012';
	const provider: SandboxProvider = {
		async create(_image, config) {
			receipts.configs.push(config);
			return {
				id,
				async terminate() {
					receipts.terminated++;
					if (terminationError) throw Error('transport');
				},
				async exec(argv) {
					const reply =
						argv[0] === '/usr/bin/sha256sum'
							? { out: `${'a'.repeat(64)}  /opt/judge/runner\n`, err: '' }
							: replies.shift();
					if (!reply) throw Error('Unexpected exec');
					if (reply instanceof Error) throw reply;
					const data = reply;
					const chunks: Buffer[] = [];
					return {
						stdout: bytes(data.out),
						stderr: bytes(data.err),
						stdin: new WritableStream<Uint8Array>({
							write(chunk) {
								chunks.push(Buffer.from(chunk));
							},
							close() {
								receipts.inputs.push(Buffer.concat(chunks).toString());
							}
						}),
						async wait() {
							return 0;
						}
					} satisfies Process;
				}
			};
		}
	};
	const sink: JudgeSink = {
		async noteSandbox() {
			return leaseActive;
		},
		async noteStart(stage) {
			receipts.stages.push(stage);
			return leaseActive;
		},
		async complete(r) {
			receipts.completed.push(r);
		},
		async fail(f) {
			receipts.failed.push(f);
		},
		async retryTermination(id) {
			receipts.retried.push(id);
		}
	};
	return {
		receipts,
		provider,
		sink,
		failTermination() {
			terminationError = true;
		},
		expireLease() {
			leaseActive = false;
		},
		changeId(value: string) {
			id = value;
		}
	};
}
async function run(f = fixture(), b = boundary([result(''), result('PUBLIC_ANSWER')])) {
	await judgeAttempt(
		f.claim,
		f.claim.kind === 'scored' ? f.blob : undefined,
		b.provider,
		b.sink,
		'dev:test',
		'attempt1'
	);
	return b.receipts;
}

test('rejects source, test and environment binding drift before creating any sandbox', async () => {
	for (const drift of ['source', 'tests', 'environment', 'missing'] as const) {
		const f = fixture('scored');
		if (drift === 'source') f.claim.source += '!';
		if (drift === 'tests') f.blob = gzipSync('{}');
		if (drift === 'environment') f.claim.environment.modalImageId = 'im-other';
		if (drift === 'missing') delete f.claim.snapshot.sourceSha256;
		const r = await run(f);
		expect(r.configs).toHaveLength(0);
		expect(r.completed).toHaveLength(0);
		expect(r.failed).toEqual([{ failureClass: 'platform', code: 'CONTROLLER_PREFLIGHT' }]);
	}
});

test('judges outputs outside the sandbox; only source and one input cross each exec boundary', async () => {
	const f = fixture('scored');
	const b = boundary([
		result(''),
		result('PUBLIC_ANSWER'),
		...Array.from({ length: 10 }, (_, i) => result(`SECRET_ANSWER_${i}`))
	]);
	const r = await run(f, b);
	expect(r.completed[0].verdict).toBe('AC');
	expect(r.completed[0].phase).toBe('hidden');
	expect(r.inputs).toEqual([
		'',
		'OPAQUE_SOURCE',
		'PUBLIC_INPUT',
		...Array.from({ length: 10 }, (_, i) => `SECRET_INPUT_${i}`)
	]);
	expect(JSON.stringify(r.completed)).not.toContain('SECRET_');
	expect(r.terminated).toBe(1);
	expect(r.configs[0]).toEqual({
		runtime: 'gvisor',
		cpu: 1,
		cpuLimit: 1,
		memoryMiB: 768,
		memoryLimitMiB: 768,
		timeoutMs: 40000,
		idleTimeoutMs: 20000,
		blockNetwork: true,
		workdir: '/work',
		command: ['sleep', '60'],
		tags: { app: 'beatcode', deployment: 'dev:test', attemptId: 'attempt1' }
	});
});

test('hidden wrong answers produce no output or feedback; failing samples expose only public bytes', async () => {
	const hidden = await run(
		fixture('scored'),
		boundary([result(''), result('PUBLIC_ANSWER'), result('PRIVATE_OUTPUT')])
	);
	expect(hidden.completed[0].verdict).toBe('WA');
	expect(hidden.completed[0].sampleFeedback).toBeUndefined();
	expect(JSON.stringify(hidden.completed)).not.toContain('PRIVATE_OUTPUT');
	const sample = await run(fixture(), boundary([result(''), result('wrong')]));
	expect(sample.completed[0].sampleFeedback).toEqual({
		input: 'PUBLIC_INPUT',
		expected: 'PUBLIC_ANSWER',
		actual: 'wrong'
	});
});

test('public sample feedback and compiler diagnostics preserve UTF-8 within their byte caps', async () => {
	for (const [suffix, length, fits] of [
		['é', 4095, false],
		['€', 4094, false],
		['😀', 4093, false],
		['😀', 4092, true]
	] as const) {
		const f = fixture();
		f.claim.limits.outputKiB = 8;
		f.claim.samples = [{ input: 'i'.repeat(length) + suffix, output: 'e'.repeat(length) + suffix }];
		const r = await run(f, boundary([result(''), result('a'.repeat(length) + suffix)]));
		const tail = fits ? suffix : '';
		expect(r.completed[0].sampleFeedback).toEqual({
			input: 'i'.repeat(length) + tail,
			expected: 'e'.repeat(length) + tail,
			actual: 'a'.repeat(length) + tail
		});
		expect(r.completed[0].sampleResults).toEqual([
			{ verdict: 'WA', output: 'a'.repeat(length) + tail }
		]);
	}
	const ce = await run(fixture(), boundary([result('d'.repeat(16383) + 'é', { status: 're' })]));
	expect(ce.completed[0].verdict).toBe('CE');
	expect(ce.completed[0].diagnostics).toBe('d'.repeat(16383));
});

test('missing or forged privileged status inside contestant window cannot create platform failure', async () => {
	for (const broken of [
		new Error('UNAUTHENTICATED'),
		{ out: '', err: '{"status":"ie"}' },
		{ out: '', err: '' }
	]) {
		const r = await run(fixture(), boundary([broken]));
		expect(r.failed).toEqual([
			{ failureClass: 'sandbox_lost', code: 'EXEC_LOST', timedOut: false, lowMemory: false }
		]);
		expect(r.completed).toHaveLength(0);
		expect(r.terminated).toBe(1);
	}
});

test('expired leases, backend mismatch and failed termination release or independently retry cleanup', async () => {
	const expired = boundary([]);
	expired.expireLease();
	expect((await run(fixture(), expired)).terminated).toBe(1);
	expect(expired.receipts.failed).toHaveLength(0);
	const wrong = boundary([]);
	wrong.changeId('sb-v2-wrong');
	expect((await run(fixture(), wrong)).terminated).toBe(1);
	expect(wrong.receipts.failed[0].failureClass).toBe('platform');
	const lostCleanup = boundary([result(''), result('PUBLIC_ANSWER')]);
	lostCleanup.failTermination();
	vi.useFakeTimers();
	const pending = run(fixture(), lostCleanup);
	await vi.advanceTimersByTimeAsync(100);
	expect(lostCleanup.receipts.completed).toHaveLength(0);
	await vi.advanceTimersByTimeAsync(42000);
	const r = await pending;
	vi.useRealTimers();
	expect(r.completed[0].verdict).toBe('AC');
	expect(r.retried).toEqual(['sb-1234567890123456789012']);
});

test('leftover processes end the attempt and output overflow stops reading and terminates', async () => {
	const left = await run(
		fixture(),
		boundary([result(''), result('PUBLIC_ANSWER', { status: 'leftover', leftover: 1 })])
	);
	expect(left.completed[0].verdict).toBe('RE');
	const overflow = await run(fixture(), boundary([result(''), result('x'.repeat(1026))]));
	expect(overflow.failed[0].failureClass).toBe('sandbox_lost');
	expect(overflow.terminated).toBe(1);
});

test('sample runs return each public sample result even after a wrong answer', async () => {
	const f = fixture();
	f.claim.samples.push({ input: 'SECOND_PUBLIC', output: 'second' });
	const r = await run(f, boundary([result(''), result('wrong'), result('second')]));
	expect(r.completed[0].verdict).toBe('WA');
	expect(r.completed[0].sampleResults).toEqual([
		{ verdict: 'WA', output: 'wrong' },
		{ verdict: 'AC', output: 'second' }
	]);
});

test('CPU-limit SIGKILL is TLE, rather than unexplained RE', async () => {
	const r = await run(
		fixture(),
		boundary([result(''), result('', { status: 'signal', signal: 9, cpuMs: 3000 })])
	);
	expect(r.completed[0].verdict).toBe('TLE');
});

test('failed staging writes or EOF acknowledgements reject even valid output and clean up before releasing capacity', async () => {
	for (const failure of ['write', 'close', 'write-timeout', 'close-timeout'] as const) {
		vi.useFakeTimers();
		try {
			const b = boundary([result(''), result('PUBLIC_ANSWER')]);
			const create = b.provider.create;
			b.provider.create = async (...args) => {
				const sb = await create(...args),
					exec = sb.exec;
				sb.exec = async (argv, timeout) => {
					const p = await exec(argv, timeout);
					if (runnerArgs(argv)[1] === 'run')
						p.stdin = new WritableStream({
							[failure.startsWith('write') ? 'write' : 'close']() {
								if (failure.endsWith('timeout')) return new Promise<void>(() => {});
								throw Error('broken pipe');
							}
						});
					return p;
				};
				return sb;
			};
			b.sink.fail = async (f) => {
				expect(b.receipts.terminated).toBe(1);
				b.receipts.failed.push(f);
			};
			const pending = run(fixture(), b);
			await vi.advanceTimersByTimeAsync(3999);
			if (failure.endsWith('timeout')) {
				expect(b.receipts.terminated).toBe(0);
				expect(b.receipts.completed).toHaveLength(0);
				expect(b.receipts.failed).toHaveLength(0);
			}
			await vi.advanceTimersByTimeAsync(1);
			const r = await pending;
			expect(r.completed).toHaveLength(0);
			expect(r.failed).toEqual([
				{
					failureClass: 'sandbox_lost',
					code: 'EXEC_LOST',
					timedOut: failure.endsWith('timeout'),
					lowMemory: false
				}
			]);
			expect(r.terminated).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	}
});

test('controller-observed execution time enforces aggregate budget despite forged wall counters', async () => {
	vi.useFakeTimers();
	try {
		const f = fixture();
		f.claim.limits.aggregateMs = 100;
		f.claim.samples.push(
			{ input: 'another', output: 'PUBLIC_ANSWER' },
			{ input: 'must-not-run', output: 'PUBLIC_ANSWER' }
		);
		const b = boundary([
			result(''),
			result('PUBLIC_ANSWER', { wallMs: 0 }),
			result('PUBLIC_ANSWER', { wallMs: 0 }),
			result('PUBLIC_ANSWER', { wallMs: 0 })
		]);
		const create = b.provider.create;
		b.provider.create = async (...args) => {
			const sb = await create(...args),
				exec = sb.exec;
			sb.exec = async (argv, timeout) => {
				if (runnerArgs(argv)[1] === 'run')
					await new Promise((resolve) => setTimeout(resolve, 3090));
				return exec(argv, timeout);
			};
			return sb;
		};
		const pending = run(f, b);
		await vi.advanceTimersByTimeAsync(10000);
		await pending;
		expect(b.receipts.completed[0].verdict).toBe('TLE');
		expect(b.receipts.failed).toHaveLength(0);
		expect(b.receipts.completed[0].sampleResults).toHaveLength(2);
	} finally {
		vi.useRealTimers();
	}
});

test('an endless oversized transport stream is cancelled instead of drained indefinitely', async () => {
	const b = boundary([result(''), result('')]);
	let cancelled = false,
		chunks = 0;
	const create = b.provider.create;
	b.provider.create = async (...args) => {
		const sb = await create(...args),
			exec = sb.exec;
		sb.exec = async (argv, timeout) => {
			const p = await exec(argv, timeout);
			if (runnerArgs(argv)[1] === 'run')
				p.stdout = new ReadableStream({
					pull(c) {
						chunks++;
						c.enqueue(new Uint8Array(1026));
					},
					cancel() {
						cancelled = true;
					}
				});
			return p;
		};
		return sb;
	};
	const r = await run(fixture(), b);
	expect(cancelled).toBe(true);
	expect(chunks).toBeLessThanOrEqual(2);
	expect(r.terminated).toBe(1);
	expect(r.failed[0].failureClass).toBe('sandbox_lost');
});

test('action accounting includes trusted claim and test-loading time before the sandbox boundary', async () => {
	const b = boundary([result(''), result('PUBLIC_ANSWER')]);
	const f = fixture();
	await judgeAttempt(
		f.claim,
		undefined,
		b.provider,
		b.sink,
		'dev:test',
		'attempt1',
		Date.now() - 7000
	);
	expect(b.receipts.completed[0].actionSeconds).toBeGreaterThanOrEqual(7);
});

test('exact aggregate exhaustion preserves completed public sample verdicts and outputs', async () => {
	const f = fixture();
	f.claim.limits.aggregateMs = 100;
	f.claim.samples.push({ input: 'no-budget-remains', output: 'later' });
	const r = await run(f, boundary([result(''), result('PUBLIC_ANSWER', { wallMs: 100 })]));
	expect(r.completed[0].verdict).toBe('TLE');
	expect(r.completed[0].sampleResults).toEqual([{ verdict: 'AC', output: 'PUBLIC_ANSWER' }]);
	expect(r.failed).toHaveLength(0);
});

test('authority failures before compile are platform failures, while losses after exec stay sandbox_lost', async () => {
	for (const at of ['sandbox', 'compile', 'run'] as const) {
		const b = boundary([result(''), result('PUBLIC_ANSWER')]);
		if (at === 'sandbox')
			b.sink.noteSandbox = async () => {
				throw Error('authority unavailable');
			};
		else
			b.sink.noteStart = async (stage) => {
				if (stage === at) throw Error('authority unavailable');
				return true;
			};
		const r = await run(fixture(), b);
		expect(r.failed[0]?.failureClass).toBe(at === 'run' ? 'sandbox_lost' : 'platform');
		expect(r.completed).toHaveLength(0);
		expect(r.terminated).toBe(1);
		expect(r.inputs).toEqual(
			at === 'sandbox' ? [] : at === 'compile' ? [''] : ['', 'OPAQUE_SOURCE']
		);
	}
});

test('a rejected lease at either execution stage stops without executing or publishing a result', async () => {
	for (const at of ['compile', 'run'] as const) {
		const b = boundary([result(''), result('PUBLIC_ANSWER')]);
		b.sink.noteStart = async (stage) => stage !== at;
		const r = await run(fixture(), b);
		expect(r.completed).toHaveLength(0);
		expect(r.failed).toHaveLength(0);
		expect(r.terminated).toBe(1);
		expect(r.inputs).toEqual(at === 'compile' ? [''] : ['', 'OPAQUE_SOURCE']);
	}
});

test.each(['exact-budget', 'later-terminal-failure'] as const)(
	'sample feedback retains the first failure through %s',
	async (terminal) => {
		const f = fixture();
		f.claim.limits.aggregateMs = 100;
		f.claim.samples.push(
			{ input: 'second', output: 'second-answer' },
			{ input: 'third', output: 'third-answer' }
		);
		const later =
			terminal === 'exact-budget'
				? result('second-answer', { wallMs: 90 })
				: result('later-output', { status: 'leftover', leftover: 1 });
		const r = await run(f, boundary([result(''), result('first-wrong', { wallMs: 10 }), later]));
		expect(r.completed[0].sampleFeedback).toEqual({
			input: 'PUBLIC_INPUT',
			expected: 'PUBLIC_ANSWER',
			actual: 'first-wrong'
		});
		expect(r.failed).toHaveLength(0);
	}
);

test('stages each exact input through EOF before timed execution while charging upload to controller clocks', async () => {
	vi.useFakeTimers();
	try {
		const f = fixture();
		const inputs = ['$(touch /tmp/never); `id`\n"\\$HOME', 'second\n'];
		f.claim.samples = inputs.map((input) => ({ input, output: 'PUBLIC_ANSWER' }));
		const b = boundary([result(''), result('PUBLIC_ANSWER'), result('PUBLIC_ANSWER')]);
		const starts: string[] = [];
		const uploads: string[] = [];
		const commands: string[][] = [];
		const compileLimits: { addressSpaceMiB: number; reserveMiB: number }[] = [];
		let currentInput = 'STALE_PREVIOUS_INPUT';
		const create = b.provider.create;
		b.provider.create = async (...args) => {
			const sb = await create(...args),
				exec = sb.exec;
			sb.exec = async (argv, timeout) => {
				const p = await exec(argv, timeout);
				const real = runnerArgs(argv);
				if (real[1] === 'compile')
					compileLimits.push({ addressSpaceMiB: Number(real[4]), reserveMiB: Number(real[9]) });
				if (real[1] !== 'run') return p;
				commands.push(real);
				const staged = argv[0] === '/bin/sh';
				let ready!: () => void;
				const running = new Promise<void>((resolve) => {
					ready = resolve;
				});
				const start = () => {
					starts.push(currentInput);
					ready();
				};
				if (staged) currentInput = '';
				else start(); // Direct runner exec starts its wall clock before transport arrives.
				p.stdin = new WritableStream<Uint8Array>({
					async write(chunk) {
						await new Promise((resolve) => setTimeout(resolve, 600));
						currentInput += Buffer.from(chunk).toString();
					},
					async close() {
						await new Promise((resolve) => setTimeout(resolve, 400));
						uploads.push(currentInput);
						if (staged) start();
					}
				});
				const output = p.stdout;
				p.stdout = new ReadableStream({
					async start(c) {
						await running;
						const reader = output.getReader();
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							c.enqueue(value);
						}
						c.close();
					}
				});
				return p;
			};
			return sb;
		};
		const pending = run(f, b);
		await vi.advanceTimersByTimeAsync(599);
		expect(starts).toEqual([]);
		await vi.advanceTimersByTimeAsync(400);
		expect(starts).toEqual([]); // Write is acknowledged; EOF is still pending.
		expect(b.receipts.completed).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1001);
		const r = await pending;
		expect(starts).toEqual(inputs);
		expect(uploads).toEqual(inputs);
		expect(compileLimits).toEqual([{ addressSpaceMiB: 0, reserveMiB: 128 }]);
		expect(commands).toEqual(
			Array.from({ length: 2 }, () => [
				'/opt/judge/runner',
				'run',
				'1000',
				'3',
				'336',
				'64',
				'1024',
				'64',
				'1024',
				'512',
				'256',
				'12',
				'--',
				'/work/bin/a.out'
			])
		);
		expect(r.completed[0].verdict).toBe('AC');
		expect(r.completed[0].metrics).toEqual({ testWallMs: [10, 10], execObservedMs: [1000, 1000] });
		expect(r.completed[0].sandboxSeconds).toBe(2);
		expect(r.completed[0].actionSeconds).toBe(2);
		expect(r.configs[0].timeoutMs).toBe(40000);
	} finally {
		vi.useRealTimers();
	}
});

test.each(['overflow', 'timeout'] as const)(
	'cancels pending sibling output before reporting %s and releases stream locks',
	async (failure) => {
		vi.useFakeTimers();
		try {
			const b = boundary([result(''), result('')]);
			let stdout!: ReadableStream<Uint8Array>;
			let stderr!: ReadableStream<Uint8Array>;
			let stdoutCancelled = false;
			let stderrCancelled = false;
			const create = b.provider.create;
			b.provider.create = async (...args) => {
				const sb = await create(...args),
					exec = sb.exec;
				sb.exec = async (argv, timeout) => {
					const p = await exec(argv, timeout);
					if (runnerArgs(argv)[1] !== 'run') return p;
					stdout = p.stdout = new ReadableStream({
						start(c) {
							if (failure === 'overflow') c.enqueue(new Uint8Array(1026));
						},
						cancel() {
							stdoutCancelled = true;
						}
					});
					stderr = p.stderr = new ReadableStream({
						cancel() {
							stderrCancelled = true;
						}
					});
					return p;
				};
				return sb;
			};
			b.sink.fail = async (f) => {
				expect(b.receipts.terminated).toBe(1);
				expect(stdoutCancelled).toBe(true);
				expect(stderrCancelled).toBe(true);
				expect(stdout.locked).toBe(false);
				expect(stderr.locked).toBe(false);
				b.receipts.failed.push(f);
			};
			const pending = run(fixture(), b);
			const settled = pending.then(
				() => undefined,
				(error: unknown) => error
			);
			await vi.advanceTimersByTimeAsync(4000);
			expect(await settled).toBeUndefined();
			expect(b.receipts.completed).toHaveLength(0);
			expect(b.receipts.failed).toEqual([
				{
					failureClass: 'sandbox_lost',
					code: 'EXEC_LOST',
					timedOut: failure === 'timeout',
					lowMemory: false
				}
			]);
		} finally {
			vi.useRealTimers();
		}
	}
);

test('admits a verified runner after an eight-second cold identity transport', async () => {
	vi.useFakeTimers();
	try {
		const b = boundary([result(''), result('PUBLIC_ANSWER')]);
		const create = b.provider.create;
		b.provider.create = async (...args) => {
			const sb = await create(...args),
				exec = sb.exec;
			sb.exec = async (argv, timeout) => {
				if (argv[0] === '/usr/bin/sha256sum')
					await new Promise<void>((resolve) => setTimeout(resolve, 8000));
				return exec(argv, timeout);
			};
			return sb;
		};
		const pending = run(fixture(), b);
		await vi.advanceTimersByTimeAsync(7999);
		expect(b.receipts.stages).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		const r = await pending;
		expect(r.failed).toEqual([]);
		expect(r.completed[0]?.verdict).toBe('AC');
		expect(r.stages).toEqual(['compile', 'run']);
		expect(r.terminated).toBe(1);
	} finally {
		vi.useRealTimers();
	}
});

test('bounds stalled runner identity transport before opening the contestant window', async () => {
	vi.useFakeTimers();
	try {
		const b = boundary([]);
		let cancelled = false;
		const create = b.provider.create;
		b.provider.create = async (...args) => {
			const sb = await create(...args),
				exec = sb.exec;
			sb.exec = async (argv, timeout) => {
				const p = await exec(argv, timeout);
				p.stdout = new ReadableStream({
					cancel() {
						cancelled = true;
					}
				});
				return p;
			};
			return sb;
		};
		b.sink.fail = async (failure) => {
			expect(cancelled).toBe(true);
			expect(b.receipts.terminated).toBe(1);
			b.receipts.failed.push(failure);
		};
		const pending = run(fixture(), b);
		await vi.advanceTimersByTimeAsync(9999);
		expect(b.receipts.terminated).toBe(0);
		expect(b.receipts.failed).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		const r = await pending;
		expect(r.stages).toEqual([]);
		expect(r.completed).toEqual([]);
		expect(r.failed).toEqual([
			{ failureClass: 'platform', code: 'CONTROLLER_PREFLIGHT', timedOut: true }
		]);
	} finally {
		vi.useRealTimers();
	}
});

test.each([3001, 10000])(
	'contestant attempts above 3000ms fail preflight (%ims)',
	async (timeMs) => {
		const f = fixture();
		f.claim.limits.timeMs = timeMs;
		const r = await run(f);
		expect(r.configs).toHaveLength(0);
		expect(r.completed).toHaveLength(0);
		expect(r.failed).toEqual([{ failureClass: 'platform', code: 'CONTROLLER_PREFLIGHT' }]);
	}
);
