import { serializeEnvironment } from '../shared/environment';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Effect } from 'effect';

export const BASE_DIGEST =
	'sha256:eb5e64286ad47187b32bda75c6b6916166ecb41da56559b8b09e0001748d2cce';
export const sha256 = (bytes: string | Uint8Array) =>
	createHash('sha256').update(bytes).digest('hex');
export const compareTokens = (actual: string, expected: string) => {
	// Token checker deliberately uses ASCII whitespace, matching the package contract.
	// eslint-disable-next-line no-control-regex
	const tokens = (s: string) => s.split(/[\x09-\x0d\x20]+/).filter(Boolean);
	const a = tokens(actual),
		b = tokens(expected);
	return a.length === b.length && a.every((v, i) => v === b[i]);
};

export interface Environment {
	_id: string;
	envId: string;
	modalImageId: string;
	baseDigest: string;
	gccVersion: string;
	runtime: string;
	cpu: number;
	runnerSha256: string;
	status: string;
}
export const environmentBinding = (e: Environment) => sha256(serializeEnvironment(e));
export interface Claim {
	kind: 'scored' | 'sample';
	source: string;
	snapshot: {
		profile: 'std' | 'strict';
		judgeEnvId: string;
		sourceSha256?: string;
		testsSha256?: string;
		environmentSha256?: string;
	};
	limits: { timeMs: number; memoryMiB: number; outputKiB: number; aggregateMs: number };
	samples: { input: string; output: string }[];
	testsSha256?: string;
	environment: Environment;
	ceilingAt: number;
}
export interface TestCase {
	input: string;
	answer: string;
	kind: 'sample' | 'secret';
}
export interface SandboxConfig {
	runtime: 'gvisor';
	cpu: 1;
	cpuLimit: 1;
	memoryMiB: number;
	memoryLimitMiB: number;
	timeoutMs: 40000;
	idleTimeoutMs: 20000;
	blockNetwork: true;
	workdir: '/work';
	command: string[];
	tags: { app: 'beatcode'; deployment: string; attemptId: string };
}
export interface Process {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	stdin: WritableStream<Uint8Array>;
	wait(): Promise<number>;
}
export interface Sandbox {
	id: string;
	exec(argv: string[], timeoutMs: number): Promise<Process>;
	terminate(): Promise<void>;
}
export interface SandboxProvider {
	create(imageId: string, config: SandboxConfig): Promise<Sandbox>;
}
export type Verdict = 'AC' | 'WA' | 'CE' | 'RE' | 'TLE' | 'MLE' | 'OLE';
export interface Result {
	verdict: Verdict;
	phase: 'sample' | 'hidden';
	diagnostics?: string;
	sampleFeedback?: { input: string; expected: string; actual: string };
	sampleResults?: { verdict: Verdict; output: string }[];
	sandboxSeconds: number;
	actionSeconds: number;
	metrics: { testWallMs: number[]; execObservedMs: number[] };
}
export interface JudgeSink {
	noteSandbox(id: string): Promise<boolean>;
	noteStart(stage: 'compile' | 'run'): Promise<boolean>;
	complete(result: Result): Promise<unknown>;
	fail(failure: {
		failureClass: 'platform' | 'sandbox_lost';
		code: string;
		timedOut?: boolean;
		lowMemory?: boolean;
	}): Promise<unknown>;
	retryTermination(id: string): Promise<unknown>;
}

export function sandboxConfig(
	memoryMiB: number,
	deployment: string,
	attemptId: string
): SandboxConfig {
	if (![256, 512].includes(memoryMiB) || !deployment) throw new Error('CONFIG');
	return {
		runtime: 'gvisor',
		cpu: 1,
		cpuLimit: 1,
		memoryMiB: memoryMiB + 512,
		memoryLimitMiB: memoryMiB + 512,
		timeoutMs: 40000,
		idleTimeoutMs: 20000,
		blockNetwork: true,
		workdir: '/work',
		command: ['sleep', '60'],
		tags: { app: 'beatcode', deployment, attemptId }
	};
}

function bind(claim: Claim, blob: Uint8Array | undefined, maxTimeMs: number): TestCase[] {
	const { snapshot: s, environment: e, limits: l } = claim;
	if (
		!/^[a-f0-9]{64}$/.test(s.testsSha256 ?? '') ||
		s.testsSha256 !== claim.testsSha256 ||
		sha256(claim.source) !== s.sourceSha256 ||
		Buffer.byteLength(claim.source) > 65536 ||
		e._id !== s.judgeEnvId ||
		environmentBinding(e) !== s.environmentSha256 ||
		e.status !== 'active' ||
		e.baseDigest !== BASE_DIGEST ||
		e.runtime !== 'gvisor' ||
		e.cpu !== 1 ||
		e.gccVersion !== '15.3.0' ||
		!/^im-[A-Za-z0-9]+$/.test(e.modalImageId) ||
		!/^[a-f0-9]{64}$/.test(e.runnerSha256) ||
		!['std', 'strict'].includes(s.profile) ||
		(claim.kind === 'sample' && s.profile !== 'std') ||
		![256, 512].includes(l.memoryMiB) ||
		!Number.isInteger(l.timeMs) ||
		l.timeMs < 500 ||
		l.timeMs > maxTimeMs ||
		!Number.isInteger(l.aggregateMs) ||
		l.aggregateMs < 1 ||
		l.aggregateMs > 15000 ||
		!Number.isInteger(l.outputKiB) ||
		l.outputKiB < 1 ||
		l.outputKiB > 1024
	)
		throw new Error('BINDING');
	if (claim.samples.length < 1 || claim.samples.length > 3) throw new Error('TESTS');
	if (claim.kind === 'sample')
		return claim.samples.map((t) => ({ input: t.input, answer: t.output, kind: 'sample' }));
	if (
		!blob ||
		blob.byteLength > 64 * 1024 * 1024 ||
		sha256(blob) !== claim.testsSha256 ||
		claim.testsSha256 !== s.testsSha256
	)
		throw new Error('TEST_BINDING');
	const parsed: unknown = JSON.parse(
		gunzipSync(blob, { maxOutputLength: 96 * 1024 * 1024 }).toString('utf8')
	);
	if (
		!parsed ||
		typeof parsed !== 'object' ||
		!('format' in parsed) ||
		parsed.format !== 'beatcode-tests/1' ||
		!('tests' in parsed) ||
		!Array.isArray(parsed.tests)
	)
		throw new Error('TESTS');
	const tests: TestCase[] = [];
	let inputBytes = 0;
	for (const t of parsed.tests) {
		if (
			!t ||
			typeof t.input !== 'string' ||
			typeof t.answer !== 'string' ||
			!['sample', 'secret'].includes(t.kind)
		)
			throw new Error('TESTS');
		inputBytes += Buffer.byteLength(t.input);
		tests.push({ input: t.input, answer: t.answer, kind: t.kind });
	}
	const samples = tests.filter((t) => t.kind === 'sample'),
		secrets = tests.filter((t) => t.kind === 'secret');
	if (
		inputBytes > 32 * 1024 * 1024 ||
		secrets.length < 10 ||
		secrets.length > 50 ||
		samples.length !== claim.samples.length ||
		samples.some(
			(t, i) => t.input !== claim.samples[i].input || t.answer !== claim.samples[i].output
		)
	)
		throw new Error('TESTS');
	return [...samples, ...secrets];
}

class StreamOverflow extends Error {}
// Never retain SDK/stream exceptions, which can include source or hidden input.
class ControllerFailure extends Error {}
const transport = <A>(operation: () => PromiseLike<A>) =>
	Effect.tryPromise({ try: operation, catch: () => new ControllerFailure('TRANSPORT') });

export function readBoundedEffect(stream: ReadableStream<Uint8Array>, cap: number) {
	return Effect.scoped(
		Effect.gen(function* () {
			let done = false;
			const reader = yield* Effect.acquireRelease(
				Effect.sync(() => stream.getReader()),
				(reader) =>
					Effect.sync(() => {
						// Cancellation acknowledgement can itself stall. Initiate it, release the
						// local lock, and let sandbox termination bound the remote work.
						if (!done) void reader.cancel().catch(() => {});
						reader.releaseLock();
					})
			);
			const chunks: Uint8Array[] = [];
			let bytes = 0;
			for (;;) {
				const next = yield* transport(() => reader.read());
				if (next.done) {
					done = true;
					return Buffer.concat(chunks, bytes);
				}
				bytes += next.value.byteLength;
				if (bytes > cap) return yield* Effect.fail(new StreamOverflow());
				chunks.push(next.value);
			}
		})
	);
}
export function readBounded(stream: ReadableStream<Uint8Array>, cap: number): Promise<Buffer> {
	return Effect.runPromise(readBoundedEffect(stream, cap));
}

function sendInput(stream: WritableStream<Uint8Array>, input?: string) {
	return Effect.scoped(
		Effect.gen(function* () {
			let sent = false;
			const writer = yield* Effect.acquireRelease(
				Effect.sync(() => stream.getWriter()),
				(writer) =>
					Effect.sync(() => {
						if (!sent) void writer.abort().catch(() => {});
						writer.releaseLock();
					})
			);
			if (input !== undefined) yield* transport(() => writer.write(Buffer.from(input)));
			yield* transport(() => writer.close());
			sent = true;
		})
	);
}
interface Trailer {
	status: string;
	signal?: number;
	wallMs: number;
	cpuMs: number;
	minAvailMb: number;
	diskBaseMb: number;
	leftover: number;
}
function trailer(bytes: Buffer): Trailer {
	const t = JSON.parse(bytes.toString('utf8')) as Trailer;
	if (
		!t ||
		!['ok', 'tle', 'ole', 'mle', 'disk', 're', 'signal', 'leftover'].includes(t.status) ||
		![t.wallMs, t.cpuMs, t.minAvailMb, t.diskBaseMb, t.leftover].every(
			(v) => Number.isFinite(v) && v >= 0
		) ||
		t.wallMs > 20000 ||
		(t.status === 'ok' && t.leftover !== 0)
	)
		throw new Error('TRAILER');
	return t;
}
// Trusted constant only: input is streamed to cat, runner arguments remain positional.
// /work is root-owned 0755; replacing the file under umask 077 creates mode 0600.
const STAGE_INPUT =
	'set -eu; umask 077; rm -f -- /work/current-input; cat > /work/current-input; exec /opt/judge/runner "$@" < /work/current-input';
const clip = (s: string, bytes: number) => {
	const encoded = Buffer.from(s);
	if (encoded.byteLength <= bytes) return s;
	let end = bytes;
	while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
	return encoded.subarray(0, end).toString('utf8');
};
const diagnostics = (s: string) => clip(s.replace(/\/(?:[^\s:/]+\/)+/g, '<sys>/'), 16384);

/** Contestant entry point: the per-test ceiling always remains 3000ms. */
export function judgeAttempt(...args: JudgeArguments): Promise<void> {
	return Effect.runPromise(judgeWorkflow(3000, ...args));
}

/** Internal operator path for private, source/version-bound reference jobs only.
 * Never select this entry point using contestant arguments or a public endpoint.
 */
export function judgeCalibrationReference(...args: JudgeArguments): Promise<void> {
	return Effect.runPromise(judgeWorkflow(10000, ...args));
}
type JudgeArguments = [
	claim: Claim,
	blob: Uint8Array | undefined,
	provider: SandboxProvider,
	sink: JudgeSink,
	deployment: string,
	attemptId: string,
	actionStartedAt?: number
];

function judgeWorkflow(
	maxTimeMs: number,
	claim: Claim,
	blob: Uint8Array | undefined,
	provider: SandboxProvider,
	sink: JudgeSink,
	deployment: string,
	attemptId: string,
	actionStartedAt = Date.now()
) {
	return Effect.gen(function* () {
		const started = actionStartedAt;
		let created = started,
			createTick = 0,
			lifetimeFrom = started,
			unresolvedCleanup = false,
			sandbox: Sandbox | undefined;
		let window = false,
			lowMemory = false,
			timedOut = false,
			active = true;
		let pendingResult: Omit<Result, 'sandboxSeconds' | 'actionSeconds' | 'metrics'> | undefined;
		let pendingFailure: Parameters<JudgeSink['fail']>[0] | undefined;
		let firstSampleFailure:
			{ verdict: Verdict; feedback: NonNullable<Result['sampleFeedback']> } | undefined;
		const metrics = { testWallMs: [] as number[], execObservedMs: [] as number[] };
		const finish = (verdict: Verdict, phase: 'sample' | 'hidden', extra: Partial<Result> = {}) =>
			Effect.sync(() => {
				window = false;
				pendingResult = {
					verdict,
					phase,
					...extra,
					...(phase === 'sample' && firstSampleFailure
						? { sampleFeedback: firstSampleFailure.feedback }
						: {})
				};
			});
		const deadline = <A, E, R>(operation: Effect.Effect<A, E, R>, timeoutMs: number) =>
			Effect.timeoutOrElse(operation, {
				duration: timeoutMs,
				orElse: () =>
					Effect.suspend(() => {
						timedOut = true;
						return Effect.fail(new ControllerFailure('EXEC_TIMEOUT'));
					})
			});
		// The create request can precede remote birth. Use its earlier timestamp and
		// reserve the adapter's two-second termination/poll window before hard expiry.
		const canFinishExec = (timeoutMs: number) =>
			performance.now() - createTick + timeoutMs + 2000 <= 40000;
		const exec = (argv: string[], input: string, cap: number, timeoutMs: number) =>
			deadline(
				Effect.gen(function* () {
					if (!sandbox) return yield* Effect.fail(new ControllerFailure('SANDBOX'));
					const sb = sandbox;
					// Authority acknowledgement alone cannot start contestant-controlled code.
					// Once dispatch begins, transport failure is ambiguous and must preserve I7.
					window = true;
					const p = yield* transport(() => sb.exec(argv, timeoutMs));
					const [out, err, code] = yield* Effect.all(
						[
							readBoundedEffect(p.stdout, cap),
							readBoundedEffect(p.stderr, 4096),
							transport(() => p.wait()),
							sendInput(p.stdin, input)
						],
						{ concurrency: 'unbounded' }
					);
					if (code !== 0) return yield* Effect.fail(new ControllerFailure('RUNNER_EXIT'));
					return { out: out.toString('utf8'), t: trailer(err) };
				}),
				timeoutMs
			);
		const releaseSandbox = (sb: Sandbox) =>
			transport(() => sb.terminate()).pipe(
				Effect.catchCause(() =>
					Effect.gen(function* () {
						unresolvedCleanup = true;
						yield* transport(() => sink.retryTermination(sb.id)).pipe(
							Effect.catchCause(() => Effect.void)
						);
						// Retain the lease/reservation through the hard server lifetime if cleanup cannot be confirmed.
						const remaining = lifetimeFrom + 41000 - Date.now();
						if (remaining > 0) yield* Effect.sleep(remaining);
					})
				)
			);
		yield* Effect.scoped(
			Effect.gen(function* () {
				const tests = bind(claim, blob, maxTimeMs),
					l = claim.limits;
				if (Date.now() >= claim.ceilingAt) throw new Error('CEILING');
				created = Date.now();
				createTick = performance.now();
				sandbox = yield* Effect.acquireRelease(
					transport(() =>
						provider.create(
							claim.environment.modalImageId,
							sandboxConfig(l.memoryMiB, deployment, attemptId)
						)
					).pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								lifetimeFrom = Date.now();
							})
						)
					),
					releaseSandbox
				);
				const sb = sandbox;
				if (!/^sb-[0-9A-Za-z]{22}$/.test(sb.id)) throw new Error('BACKEND');
				active = yield* transport(() => sink.noteSandbox(sb.id));
				if (!active) return;
				// Verify trusted image identity before any contestant-controlled exec. No shell interpolation.
				// Cold transport can exceed the hash process deadline; bound dispatch and streams separately.
				const [hash, , code] = yield* deadline(
					Effect.gen(function* () {
						const check = yield* transport(() =>
							sb.exec(['/usr/bin/sha256sum', '/opt/judge/runner'], 5000)
						);
						return yield* Effect.all(
							[
								readBoundedEffect(check.stdout, 256),
								readBoundedEffect(check.stderr, 1024),
								transport(() => check.wait()),
								sendInput(check.stdin)
							],
							{ concurrency: 'unbounded' }
						);
					}),
					10000
				);
				if (
					code !== 0 ||
					hash.toString().trim() !== `${claim.environment.runnerSha256}  /opt/judge/runner`
				)
					throw new Error('RUNNER_BINDING');
				active = yield* transport(() => sink.noteStart('compile'));
				if (!active) return;
				const args = (mode: 'compile' | 'run', wall: number, diskBase: number) => [
					'/opt/judge/runner',
					mode,
					String(wall),
					String(Math.ceil((2 * wall) / 1000) + 1),
					String(mode === 'run' ? l.memoryMiB + 80 : 0),
					'64',
					mode === 'compile' ? '65536' : '1024',
					'64',
					String(mode === 'compile' ? 16384 : l.outputKiB * 1024),
					// Preserve the sandbox's 512 MiB reserve during contestant execution.
					// Compile retains its separate allowance; ADR0004 records the policy change.
					String(mode === 'run' ? 512 : 128),
					mode === 'compile' ? '512' : '256',
					String(diskBase),
					'--',
					...(mode === 'run'
						? ['/work/bin/a.out']
						: [
								'/usr/local/bin/g++',
								...(claim.snapshot.profile === 'strict'
									? ['-std=c++20', '-pedantic-errors']
									: ['-std=gnu++20']),
								'-O2',
								'-pipe',
								'-DONLINE_JUDGE',
								'-fdiagnostics-color=never',
								'-fmax-errors=20',
								'main.cpp',
								'-o',
								'a.out'
							])
				];
				if (!canFinishExec(15000)) {
					yield* finish('TLE', 'sample');
					return;
				}
				const compiled = yield* exec(args('compile', 14000, -1), claim.source, 16385, 15000);
				lowMemory ||= compiled.t.minAvailMb <= 256;
				if (compiled.t.status !== 'ok') {
					yield* finish('CE', 'sample', { diagnostics: diagnostics(compiled.out) });
					return;
				}
				const diskBase = compiled.t.diskBaseMb;
				let aggregate = 0,
					observed = 0;
				const sampleResults: { verdict: Verdict; output: string }[] = [];
				for (const t of tests) {
					active = yield* transport(() => sink.noteStart('run'));
					if (!active) return;
					const before = Date.now(),
						wall = Math.min(l.timeMs, l.aggregateMs - aggregate);
					const phase = t.kind === 'sample' ? 'sample' : 'hidden';
					if (wall <= 0 || !canFinishExec(wall + 3000)) {
						yield* finish('TLE', phase, claim.kind === 'sample' ? { sampleResults } : {});
						return;
					}
					const r = yield* exec(
						['/bin/sh', '-c', STAGE_INPUT, 'beatcode-run', ...args('run', wall, diskBase).slice(1)],
						t.input,
						l.outputKiB * 1024 + 1,
						wall + 3000
					);
					const elapsed = Date.now() - before;
					aggregate += r.t.wallMs;
					observed += elapsed;
					metrics.testWallMs.push(r.t.wallMs);
					metrics.execObservedMs.push(elapsed);
					lowMemory ||= r.t.minAvailMb <= 256;
					let verdict: Verdict =
						r.t.status === 'ok'
							? compareTokens(r.out, t.answer)
								? 'AC'
								: 'WA'
							: r.t.status === 'tle' ||
								  (r.t.status === 'signal' &&
										r.t.signal === 9 &&
										r.t.cpuMs >= (Math.ceil((2 * wall) / 1000) + 1) * 1000)
								? 'TLE'
								: r.t.status === 'ole'
									? 'OLE'
									: r.t.status === 'mle'
										? 'MLE'
										: 'RE';
					const aggregateExceeded =
						aggregate > l.aggregateMs ||
						observed > l.aggregateMs + metrics.testWallMs.length * 3000;
					if (aggregateExceeded) verdict = 'TLE';
					if (claim.kind === 'sample') sampleResults.push({ verdict, output: clip(r.out, 4096) });
					if (verdict !== 'AC') {
						if (
							claim.kind === 'sample' &&
							r.t.status !== 'leftover' &&
							aggregate < l.aggregateMs &&
							!aggregateExceeded
						) {
							firstSampleFailure ??= {
								verdict,
								feedback: {
									input: clip(t.input, 4096),
									expected: clip(t.answer, 4096),
									actual: clip(r.out, 4096)
								}
							};
							continue;
						}
						yield* finish(verdict, phase, {
							...(claim.kind === 'sample' ? { sampleResults } : {}),
							...(phase === 'sample'
								? {
										sampleFeedback: {
											input: clip(t.input, 4096),
											expected: clip(t.answer, 4096),
											actual: clip(r.out, 4096)
										}
									}
								: {})
						});
						return;
					}
				}
				yield* finish(
					firstSampleFailure?.verdict ?? 'AC',
					claim.kind === 'sample' ? 'sample' : 'hidden',
					claim.kind === 'sample'
						? {
								sampleResults,
								...(firstSampleFailure ? { sampleFeedback: firstSampleFailure.feedback } : {})
							}
						: {}
				);
			}).pipe(
				Effect.catchCause(() =>
					Effect.sync(() => {
						// No sandbox-provided status, message, or claimed platform failure can create an infrastructure incident.
						if (active)
							pendingFailure = {
								failureClass: window ? 'sandbox_lost' : 'platform',
								code: window ? 'EXEC_LOST' : 'CONTROLLER_PREFLIGHT',
								...(window ? { timedOut, lowMemory } : timedOut ? { timedOut: true } : {})
							};
					})
				)
			)
		);
		// The sandbox scope is closed before any callback can publish or release its lease.

		const result = pendingResult,
			failure = pendingFailure;
		if (active && result)
			yield* transport(() =>
				sink.complete({
					...result,
					metrics,
					sandboxSeconds: sandbox
						? unresolvedCleanup
							? 40
							: Math.min(40, (Date.now() - created) / 1000)
						: 0,
					actionSeconds: (Date.now() - started) / 1000
				})
			);
		else if (active && failure) yield* transport(() => sink.fail(failure));
	});
}
