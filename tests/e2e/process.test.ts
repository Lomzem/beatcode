import { expect, it } from 'vitest';
import { Effect } from 'effect';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from './process';

async function isExecuting(pid: number) {
	try {
		const status = await readFile(`/proc/${pid}/stat`, 'utf8');
		return status.slice(status.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw cause;
	}
}

it.each([true, false])(
	'cancellation drains a process group (parent resists=%s) before remote cleanup',
	async (resists) => {
		const folder = await mkdtemp(join(tmpdir(), 'beatcode-process-'));
		const pidFile = join(folder, 'pid');
		const childPidFile = join(folder, 'child-pid');
		let descendant = 0;
		const cancellation = new AbortController();
		let pid = 0;
		let cleaned = false;
		let executingAtCleanup = true;
		const program = runCommand(
			[
				'node',
				'-e',
				`
		const {spawn}=require('node:child_process');
		${resists ? "process.on('SIGTERM',()=>{});" : ''}
		spawn(process.execPath,['-e',${JSON.stringify(`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(childPidFile)},String(process.pid));setInterval(()=>{},1000);`)}],{stdio:'ignore'});
		require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
		setInterval(()=>{},1000);
	`
			],
			'Child failed',
			process.env
		).pipe(
			Effect.ensuring(
				Effect.promise(async () => {
					executingAtCleanup = (await isExecuting(pid)) || (await isExecuting(descendant));
					cleaned = true;
				})
			)
		);
		const running = Effect.runPromise(program, { signal: cancellation.signal }).catch(
			() => undefined
		);
		try {
			for (let i = 0; i < 100 && !pid; i++) {
				try {
					pid = Number(await readFile(pidFile, 'utf8'));
				} catch {
					await new Promise((accept) => setTimeout(accept, 20));
				}
			}
			for (let i = 0; i < 100 && !descendant; i++) {
				try {
					descendant = Number(await readFile(childPidFile, 'utf8'));
				} catch {
					await new Promise((accept) => setTimeout(accept, 20));
				}
			}
			expect(pid).toBeGreaterThan(0);
			expect(descendant).toBeGreaterThan(0);
			cancellation.abort();
			let timeout: ReturnType<typeof setTimeout>;
			try {
				await Promise.race([
					running,
					new Promise((_, reject) => {
						timeout = setTimeout(
							() =>
								reject(new Error('Process group shutdown prevented remote cleanup for 5 seconds')),
							5000
						);
					})
				]);
			} finally {
				clearTimeout(timeout!);
			}
			expect(cleaned).toBe(true);
			expect(executingAtCleanup, 'Remote cleanup must see no executing process-group member').toBe(
				false
			);
			expect(() => process.kill(pid, 0)).toThrow();
			let executing = false;
			try {
				const status = await readFile(`/proc/${descendant}/stat`, 'utf8');
				executing = status.split(' ')[2] !== 'Z';
			} catch {
				/* Reaped. */
			}
			expect(executing, 'A detached descendant must not outlive the scoped command').toBe(false);
		} finally {
			if (pid) {
				try {
					process.kill(-pid, 'SIGKILL');
				} catch {
					/* Already reaped. */
				}
			}
			await running;
			await rm(folder, { recursive: true, force: true });
		}
	},
	10000
);

it.each([0, 1])(
	'normal exit %s stops a resistant closed-stdio descendant',
	async (code) => {
		const folder = await mkdtemp(join(tmpdir(), 'beatcode-normal-process-'));
		const file = join(folder, 'pid');
		let descendant = 0;
		let executingAtCleanup = true;
		try {
			const descendantCode = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},1000);`;
			const parentCode = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:'ignore'});c.unref();const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(file)})){clearInterval(timer);process.exit(${code});}},10);`;
			const result = Effect.runPromise(
				runCommand(['node', '-e', parentCode], 'normal exit', process.env).pipe(
					Effect.ensuring(
						Effect.promise(async () => {
							descendant = Number(await readFile(file, 'utf8'));
							executingAtCleanup = await isExecuting(descendant);
						})
					)
				)
			);
			if (code === 0) await expect(result).resolves.toBeUndefined();
			else
				await expect(result).rejects.toMatchObject({
					_tag: 'ProcessFailure',
					message: 'normal exit'
				});
			expect(executingAtCleanup, 'Remote cleanup must follow descendant shutdown').toBe(false);
			descendant = Number(await readFile(file, 'utf8'));
			let executing = false;
			try {
				const status = await readFile(`/proc/${descendant}/stat`, 'utf8');
				executing = status.split(' ')[2] !== 'Z';
			} catch {
				/* Reaped. */
			}
			expect(executing, 'Normal completion must finalize the entire process group').toBe(false);
		} finally {
			if (descendant) {
				try {
					process.kill(descendant, 'SIGKILL');
				} catch {
					/* Reaped. */
				}
			}
			await rm(folder, { recursive: true, force: true });
		}
	},
	10000
);
