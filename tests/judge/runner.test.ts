import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, test } from 'vitest';

// The runner runs as root and changes mounts, so it runs only inside a disposable container.
const run = promisify(execFile);
const IMAGE =
	'debian:trixie-slim@sha256:020c0d20b9880058cbe785a9db107156c3c75c2ac944a6aa7ab59f2add76a7bd';
// Contestant program: a directory chain of the requested depth below its working directory.
const TREE = `#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>
int main(int c, char **v) { for (long i = atol(v[1]); i > 0; i--) if (mkdir("d", 0700) || chdir("d")) return 9; return 0; }
`;
// Each child stays below RLIMIT_AS; untouched mappings exceed only the aggregate allowance.
const RESERVATIONS = `#include <sys/mman.h>
#include <unistd.h>
int main(void) {
  int ready[2]; if (pipe(ready)) return 9;
  for (int i = 0; i < 4; i++) {
    pid_t child = fork(); if (child < 0) return 9;
    if (!child) {
      close(ready[0]);
      if (mmap(0, 48UL << 20, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0) == MAP_FAILED) return 9;
      if (write(ready[1], "r", 1) != 1) return 9;
      close(ready[1]);
      for (;;) pause();
    }
  }
  close(ready[1]);
  for (int i = 0; i < 4; i++) { char byte; if (read(ready[0], &byte, 1) != 1) return 9; }
  close(ready[0]);
  for (;;) pause();
}
`;
// Ordinary fork/wait helpers race /proc sampling while staying well below the AS cap.
const HELPERS = `#include <sys/wait.h>
#include <unistd.h>
int main(void) {
  for (int worker = 0; worker < 4; worker++) {
    pid_t pid = fork(); if (pid < 0) return 9;
    if (!pid) {
      for (int i = 0; i < 32; i++) {
        pid_t helper = fork(); if (helper < 0) _exit(9);
        if (!helper) { usleep(500); _exit(0); }
        int status;
        if (waitpid(helper, &status, 0) != helper || !WIFEXITED(status) || WEXITSTATUS(status)) _exit(9);
      }
      _exit(0);
    }
  }
  for (int worker = 0; worker < 4; worker++) {
    int status;
    if (wait(&status) < 0 || !WIFEXITED(status) || WEXITSTATUS(status)) return 9;
  }
  return write(1, "ok\\n", 3) == 3 ? 0 : 9;
}
`;
let dir: string;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'beatcode-runner-'));
	chmodSync(dir, 0o755); // the contestant executes as nobody
	await run('gcc', [
		...['-O2', '-Wall', '-Wextra', '-Werror', '-static'],
		...['-o', join(dir, 'runner'), resolve('judge/runner.c')]
	]);
	writeFileSync(join(dir, 'tree.c'), TREE);
	await run('gcc', ['-O2', '-static', '-o', join(dir, 'tree'), join(dir, 'tree.c')]);
	writeFileSync(join(dir, 'reservations.c'), RESERVATIONS);
	await run('gcc', [
		'-O2',
		'-static',
		'-o',
		join(dir, 'reservations'),
		join(dir, 'reservations.c')
	]);
	writeFileSync(join(dir, 'helpers.c'), HELPERS);
	await run('gcc', ['-O2', '-static', '-o', join(dir, 'helpers'), join(dir, 'helpers.c')]);
}, 60000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Stderr = { stderr?: unknown };
const settle = <T>(p: Promise<T>) => p.catch((error: unknown) => ({ error }));

/** Runs consecutive tests in one sandbox image layout and returns each runner exit and trailer. */
async function tests(
	contestants: string[],
	{ wallMs = 20000, asMb = 0 }: { wallMs?: number; asMb?: number } = {}
) {
	const runner = `/opt/judge/runner run ${wallMs} 41 ${asMb} 64 1024 64 64 128 1000000000 0 --`;
	const script = [
		'mkdir -p /work/sub /work/bin && chown 65534:65534 /work/sub && chmod 0700 /work/sub && chmod 0755 /work /work/bin',
		...contestants.map(
			(c) =>
				`${runner} ${c} </dev/null >/dev/null 2>/trailer; printf '%s\\t%s\\n' "$?" "$(cat /trailer)"`
		)
	].join('\n');
	const name = `beatcode-runner-test-${randomUUID()}`;
	// Ample fds and an 8 MiB runner stack: cleanup depth is then bounded only by the runner itself.
	const result = await settle(
		run(
			'docker',
			[
				...['run', '--rm', '--name', name, '--network', 'none'],
				// AppArmor's docker-default (hosted CI) denies chmod on runc's masked /proc file binds,
				// which the runner's mount check needs; only the LSM layer is dropped, caps and seccomp stay.
				...['--security-opt', 'apparmor=unconfined'],
				...['--ulimit', 'nofile=1048576:1048576', '--ulimit', 'stack=8388608:-1'],
				...['-v', `${dir}:/opt/judge:ro`, IMAGE, 'sh', '-c', script]
			],
			{ timeout: 45000, killSignal: 'SIGKILL' } // the client would proxy SIGTERM and keep waiting
		)
	);
	// A killed client leaves its container running. Removing an auto-removed container succeeds,
	// and one the daemon is already auto-removing needs no second removal.
	const removal = await settle(run('docker', ['rm', '--force', name], { timeout: 10000 }));
	const leak =
		'error' in removal && !/already in progress/.test(String((removal.error as Stderr).stderr))
			? removal.error
			: undefined;
	if ('error' in result) throw leak ? new AggregateError([result.error, leak]) : result.error;
	if (leak) throw leak;
	return result.stdout
		.trim()
		.split('\n')
		.map((line) => {
			const [exit, trailer] = line.split('\t');
			return {
				exit: Number(exit),
				trailer: trailer?.startsWith('{') ? JSON.parse(trailer) : trailer
			};
		});
}
const tree = (depth: number) => `/opt/judge/tree ${depth}`;
const clean = `/bin/sh -c 'test -z "$(find /work/sub /tmp -mindepth 1)"'`;

test('a contestant directory tree is removed before the next test can observe it', async () => {
	const [first, next] = await tests([tree(100), clean]);
	expect(first).toMatchObject({ exit: 0, trailer: { status: 'ok' } });
	expect(next).toMatchObject({ exit: 0, trailer: { status: 'ok', exitCode: 0 } });
}, 60000);

test('the run that leaves an unremovable directory tree reports leftover', async () => {
	// An unbounded recursive cleanup overflows an 8 MiB stack below 60,000 levels.
	const [first] = await tests([tree(60000)]);
	expect(first).toMatchObject({
		exit: 0,
		trailer: { status: 'leftover', exitCode: 0, leftover: 0 }
	});
}, 60000);

test('aggregate address-space reservations report MLE and leave no contestant processes', async () => {
	const [first, next] = await tests(['/opt/judge/reservations', clean], {
		wallMs: 2000,
		asMb: 144
	});
	expect(first).toMatchObject({ exit: 0, trailer: { status: 'mle', leftover: 0, v: 3 } });
	expect(next).toMatchObject({ exit: 0, trailer: { status: 'ok', exitCode: 0, leftover: 0 } });
}, 60000);

test('short-lived helpers can exit and be reaped below the aggregate address-space cap', async () => {
	// Two finite runs exercise normal process churn without a long race/fuzz campaign.
	const [first, second, next] = await tests(['/opt/judge/helpers', '/opt/judge/helpers', clean], {
		wallMs: 2000,
		asMb: 144
	});
	for (const result of [first, second]) {
		expect(result).toMatchObject({
			exit: 0,
			trailer: { status: 'ok', exitCode: 0, outBytes: 3, leftover: 0, v: 3 }
		});
	}
	expect(next).toMatchObject({ exit: 0, trailer: { status: 'ok', exitCode: 0, leftover: 0 } });
}, 60000);
