import { afterEach, expect, it, vi } from 'vitest';
import { ModalClient } from 'modal';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Process } from '../../judge/controller';

vi.mock('modal', () => ({ ModalClient: vi.fn() }));
// Keep the real accounting workflow, but intercept evidence writes at the filesystem boundary.
// In particular, never read, reserve against, or reset the exhausted live ledger.
vi.mock('node:fs', async (original) => {
	const fs = await original<typeof import('node:fs')>();
	return {
		...fs,
		existsSync: () => false,
		mkdirSync: vi.fn(),
		appendFileSync: vi.fn(),
		writeFileSync: vi.fn()
	};
});

function deferred<A>() {
	let resolve!: (value: A) => void;
	const promise = new Promise<A>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
function stream(text = '') {
	return new ReadableStream<Uint8Array>({
		start(c) {
			if (text) c.enqueue(Buffer.from(text));
			c.close();
		}
	});
}
function processOutput(out: string, err = ''): Process {
	return {
		stdout: stream(out),
		stderr: stream(err),
		stdin: new WritableStream(),
		wait: async () => 0
	};
}

function setupQualificationCli(filter?: string) {
	vi.resetModules();
	vi.clearAllMocks();
	process.exitCode = 0;
	vi.stubEnv('BEATCODE_ALLOW_CONTAINMENT', 'reviewed');
	vi.stubEnv('BEATCODE_VALIDATION_PROBES', filter);
	vi.stubEnv('MODAL_APP_NAME', 'beatcode-judge-validation-20261023');
	vi.stubEnv('MODAL_CONFIG_PATH', resolve('.scratch/competitive-leetcode/.modal-production.toml'));
	vi.stubEnv('MODAL_SANDBOX_V2', '0');
}

// SDK responses exercise the real CLI, controller, trailer decoding and accounting.
// They establish qualification policy only; actual containment belongs to the cloud probes.
function qualificationSdk(
	memoryBurstStatus: 'mle' | 'lost' = 'mle',
	compilerStatus = 'mle',
	directoryStatus = 'leftover'
) {
	const metadata = JSON.parse(readFileSync('judge/image.json', 'utf8'));
	const trailer = (status: string) =>
		JSON.stringify({
			status,
			minAvailMb: 500,
			diskPeakMb: 1,
			diskBaseMb: 1,
			sweeps: 1,
			leftover: 0,
			maxrssKb: 1,
			wallMs: 1,
			cpuMs: 1
		});
	const outputs: Record<string, string> = {
		'cross-test-files': 'clean',
		'short-lived-helpers': 'ok',
		'directory-cleanup': 'clean',
		'directory-cleanup-depth': 'done',
		'runner-fd-forgery': 'denied',
		'memory-backed-mounts': 'locked',
		'non-dumpable-daemon-sweep': 'done',
		'std-vla': '7',
		'typical-bits-solution': '42',
		'scoped-network': 'blocked'
	};
	const statuses: Record<string, string> = {
		'output-flood': 'ole',
		'many-file-disk-growth': 'disk',
		'per-attempt-disk-baseline': 'disk',
		'aggregate-address-space': 'mle',
		'memory-burst': memoryBurstStatus,
		'directory-cleanup-depth': directoryStatus,
		'fork-bomb': 'tle'
	};
	vi.mocked(ModalClient).mockImplementation(function () {
		return {
			profile: { tokenId: 'fixture', tokenSecret: 'fixture', sandboxV2: false },
			close() {},
			apps: { fromName: async () => ({ appId: 'ap-fixture' }) },
			images: { fromId: async () => ({}) },
			sandboxes: {
				async create(_app: unknown, _image: unknown, config: { tags: { attemptId: string } }) {
					const name = config.tags.attemptId;
					return {
						sandboxId: 'sb-' + 'a'.repeat(22),
						async exec(argv: string[]) {
							if (argv[0] === '/usr/bin/sha256sum')
								return processOutput(`${metadata.runnerSha256}  /opt/judge/runner`);
							if (argv[0] === '/usr/bin/dd') return processOutput('');
							if (argv[1] === 'compile') {
								if (name === 'compiler-memory-blowup') {
									if (compilerStatus === 'lost') throw new Error('SDK sandbox terminated');
									return processOutput('', trailer(compilerStatus));
								}
								return name === 'strict-vla'
									? processOutput('error: variable length array', trailer('re'))
									: processOutput('', trailer('ok'));
							}
							if (statuses[name] === 'lost') throw new Error('SDK sandbox terminated');
							return processOutput(outputs[name] ?? '', trailer(statuses[name] ?? 'ok'));
						},
						async terminate() {},
						async poll() {
							return 0;
						}
					};
				},
				async *list() {}
			}
		} as unknown as ModalClient;
	});
}

function qualificationReport() {
	const writes = vi
		.mocked(writeFileSync)
		.mock.calls.filter(([path]) => String(path).endsWith('containment-results.json'));
	return JSON.parse(String(writes.at(-1)?.[1])) as {
		name: string;
		verdict: string;
		expected: string;
		qualificationScope: string;
	}[];
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
	process.exitCode = 0;
});

it.each(['mle', 'lost'] as const)(
	'qualifies memory-burst only when the sandbox returns MLE: %s',
	async (status) => {
		setupQualificationCli();
		qualificationSdk(status);
		await import('../../scripts/judge/verify-containment');
		expect({
			verdict: qualificationReport().find((row) => row.name === 'memory-burst')?.verdict,
			exitCode: process.exitCode
		}).toEqual({
			verdict: status === 'lost' ? 'sandbox_lost' : 'MLE',
			exitCode: status === 'lost' ? 1 : 0
		});
	}
);

it.each(['', ' ', ',', 'unknown-probe', 'memory-burst,unknown-probe', 'memory-burst,'])(
	'rejects invalid probe selections before opening a cloud client: %j',
	async (filter) => {
		setupQualificationCli(filter);
		qualificationSdk();
		await expect(import('../../scripts/judge/verify-containment')).rejects.toThrow(
			'CONTAINMENT_PROBE_SELECTION'
		);
		expect(ModalClient).not.toHaveBeenCalled();
	}
);

it('keeps successful filtered probes diagnostic in the JSON array and exit status', async () => {
	setupQualificationCli(' std-vla , memory-burst ');
	qualificationSdk();
	await import('../../scripts/judge/verify-containment');
	const report = qualificationReport();
	expect({
		rows: report.map(({ name, verdict, qualificationScope }) => ({
			name,
			verdict,
			qualificationScope
		})),
		exitCode: process.exitCode
	}).toEqual({
		rows: [
			{ name: 'memory-burst', verdict: 'MLE', qualificationScope: 'diagnostic' },
			{ name: 'std-vla', verdict: 'AC', qualificationScope: 'diagnostic' }
		],
		exitCode: 1
	});
});

it.each(['mle', 're', 'tle', 'lost'])(
	'qualifies compiler memory pressure only when the compile memory guard fires: %s',
	async (status) => {
		setupQualificationCli();
		qualificationSdk('mle', status);
		await import('../../scripts/judge/verify-containment');
		expect({
			verdict: qualificationReport().find((row) => row.name === 'compiler-memory-blowup')?.verdict,
			exitCode: process.exitCode
		}).toEqual({
			verdict:
				status === 'mle' ? 'CE' : status === 'lost' ? 'sandbox_lost' : 'wrong_compile_failure',
			exitCode: status === 'mle' ? 0 : 1
		});
	}
);

it.each(['leftover', 're'])(
	'qualifies an over-deep directory tree only on the cleanup verdict: %s',
	async (status) => {
		setupQualificationCli();
		qualificationSdk('mle', 'mle', status);
		await import('../../scripts/judge/verify-containment');
		expect({
			verdict: qualificationReport().find((row) => row.name === 'directory-cleanup-depth')?.verdict,
			exitCode: process.exitCode
		}).toEqual({
			verdict: status === 'leftover' ? 'RE' : 'wrong_guard',
			exitCode: status === 'leftover' ? 0 : 1
		});
	}
);

it.each(['overflow', 'dispatch', 'stdin', 'readers', 'wait', 'retry lookup failure'] as const)(
	'cleans up owned fixture work without late contestant dispatch: %s',
	async (failure) => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.stubEnv('BEATCODE_ALLOW_CONTAINMENT', 'reviewed');
		vi.stubEnv('BEATCODE_VALIDATION_PROBES', 'per-attempt-disk-baseline');
		vi.stubEnv('MODAL_APP_NAME', 'beatcode-judge-validation-20261023');
		vi.stubEnv(
			'MODAL_CONFIG_PATH',
			resolve('.scratch/competitive-leetcode/.modal-production.toml')
		);
		vi.stubEnv('MODAL_SANDBOX_V2', '0');
		const wait = deferred<number>();
		const dispatched = deferred<void>();
		const lateDispatch = deferred<Process>();
		const stdinClosed = deferred<void>();
		const overflow = failure === 'overflow' || failure === 'retry lookup failure';
		let finishStdout = () => {};
		let finishStderr = () => {};
		const stdout =
			overflow || failure === 'readers'
				? new ReadableStream<Uint8Array>({
						start(c) {
							finishStdout = () => c.close();
						},
						cancel() {
							finishStdout = () => {};
							return new Promise(() => {});
						}
					})
				: stream();
		const stderr = overflow
			? stream('x'.repeat(4097))
			: failure === 'readers'
				? new ReadableStream<Uint8Array>({
						start(c) {
							finishStderr = () => c.close();
						},
						cancel() {
							finishStderr = () => {};
						}
					})
				: stream();
		const fixtureProcess = {
			stdout,
			stderr,
			stdin: new WritableStream({
				close: () => (failure === 'stdin' ? stdinClosed.promise : undefined)
			}),
			wait: () => wait.promise
		};
		const locksAtTermination: boolean[] = [];
		const contestantDispatches: string[][] = [];
		const openClients = new Set<object>();
		let retryLookups = 0;
		const { readFileSync } = await import('node:fs');
		const metadata = JSON.parse(readFileSync('judge/image.json', 'utf8'));
		const trailer = JSON.stringify({
			status: 'ok',
			minAvailMb: 500,
			diskPeakMb: 1,
			diskBaseMb: 1,
			sweeps: 1,
			leftover: 0,
			maxrssKb: 1,
			wallMs: 1,
			cpuMs: 1
		});
		const sandbox = {
			sandboxId: 'sb-' + 'a'.repeat(22),
			async exec(argv: string[]) {
				if (argv[0] === '/usr/bin/sha256sum')
					return processOutput(`${metadata.runnerSha256}  /opt/judge/runner`);
				if (argv[1] === 'compile') return processOutput('', trailer);
				if (argv[0] === '/usr/bin/dd') {
					dispatched.resolve();
					return failure === 'dispatch' ? lateDispatch.promise : fixtureProcess;
				}
				contestantDispatches.push(argv);
				return processOutput('', trailer);
			},
			async terminate() {
				locksAtTermination.push(stdout.locked, stderr.locked);
				if (failure === 'retry lookup failure') throw new Error('fixture termination failure');
			},
			async poll() {
				return 0;
			}
		};
		vi.mocked(ModalClient).mockImplementation(function () {
			const client = {
				profile: { tokenId: 'fixture', tokenSecret: 'fixture', sandboxV2: false },
				close: () => {
					openClients.delete(client);
				},
				apps: { fromName: async () => ({ appId: 'ap-fixture' }) },
				images: { fromId: async () => ({}) },
				sandboxes: {
					create: async () => sandbox,
					async *list() {},
					fromId: async () => {
						retryLookups++;
						throw new Error('fixture lookup failure');
					}
				}
			};
			openClients.add(client);
			return client as unknown as ModalClient;
		});
		const pending = import('../../scripts/judge/verify-containment');
		await dispatched.promise;
		if (!overflow) {
			await vi.advanceTimersByTimeAsync(2999);
			expect(locksAtTermination).toEqual([]);
			await vi.advanceTimersByTimeAsync(1);
		} else {
			await vi.advanceTimersByTimeAsync(0);
		}
		// Release previously stalled SDK promises only after cleanup has run. They
		// must never regain authority to launch the contestant or acquire readers.
		const locksAtSetupDeadline = [...locksAtTermination];
		await vi.advanceTimersByTimeAsync(3000);
		if (failure === 'readers') {
			finishStdout();
			finishStderr();
		}
		lateDispatch.resolve(fixtureProcess);
		stdinClosed.resolve();
		wait.resolve(0);
		await vi.advanceTimersByTimeAsync(failure === 'retry lookup failure' ? 41000 : 10000);
		await pending;
		expect({
			locksAtTermination,
			contestantDispatches,
			openClients: openClients.size,
			locksAtSetupDeadline,
			finalLocks: [stdout.locked, stderr.locked],
			retryLookups
		}).toEqual({
			locksAtTermination: [false, false],
			contestantDispatches: [],
			openClients: 0,
			locksAtSetupDeadline: [false, false],
			finalLocks: [false, false],
			retryLookups: failure === 'retry lookup failure' ? 1 : 0
		});
	}
);
