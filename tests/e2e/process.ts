import { Effect, Data } from 'effect';
import { safeCardFailure } from './card-diagnostics';
import { safeActivationFailure } from './activation-diagnostics';
import { safeAuthBoundary } from './auth-diagnostics';
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

export class ProcessFailure extends Data.TaggedError('ProcessFailure')<{ message: string }> {}

export const runCommand = (
	args: string[],
	stage: string,
	env: NodeJS.ProcessEnv,
	cwd = process.cwd()
) =>
	Effect.suspend(() => {
		let cleanup: Effect.Effect<void> = Effect.void;
		return Effect.callback<void, ProcessFailure>((resume, signal) => {
			const child = spawn(args[0], args.slice(1), {
				cwd,
				env,
				detached: true,
				stdio: ['ignore', 'pipe', 'ignore']
			});
			let pending = '';
			child.stdout.on('data', (chunk) => {
				pending += String(chunk);
				const lines = pending.split('\n');
				pending = lines.pop()!;
				for (const line of lines) {
					const diagnostic =
						safeCardFailure(line) ?? safeActivationFailure(line) ?? safeAuthBoundary(line);
					if (diagnostic) {
						console.info(diagnostic);
						continue;
					}
					if (
						/^(?:CI clock pings: \d+|CI presence stopped: \d+|CI presence: \d+ emitted \d+ accepted \d+ failed|CI auth flags: [01]{7}|CI auth: (?:entry|portal|email|code|return)|CI progress: (?:chromium|firefox|webkit)-(?:320|768|1280) (?:host|guest|new) (?:create|signin|nickname|pass|saved)|CI case: (?:chromium|firefox|webkit)-(?:320|768|1280) (?:passed|failed|timedOut|skipped|interrupted)(?: line \d+)?|Authenticated coverage: \d+ passed, \d+ failed\/skipped; required minimum 36\.)$/.test(
							line
						)
					)
						console.info(line);
				}
			});
			let finished = false;
			const exited = new Promise<void>((accept) =>
				child.on('close', () => {
					finished = true;
					accept();
				})
			);
			child.on('error', () => resume(Effect.fail(new ProcessFailure({ message: stage }))));
			child.on('close', (code) =>
				resume(code === 0 ? Effect.void : Effect.fail(new ProcessFailure({ message: stage })))
			);
			const terminate = (kind: NodeJS.Signals = 'SIGTERM') => {
				try {
					if (child.pid) process.kill(-child.pid, kind);
				} catch {
					/* Process group already exited. */
				}
			};
			const onAbort = () => terminate();
			signal.addEventListener('abort', onAbort, { once: true });
			cleanup = Effect.promise(async () => {
				signal.removeEventListener('abort', onAbort);
				if (!finished || groupExists(child.pid)) {
					terminate();
					if (!(await groupStoppedWithin(child.pid, 2000))) {
						terminate('SIGKILL');
						if (!(await groupStoppedWithin(child.pid, 1000))) {
							child.stdout.destroy();
							child.unref();
							throw new ProcessFailure({ message: 'CI process group did not stop after SIGKILL' });
						}
					}
					if (!finished && !(await drainedWithin(exited, 1000))) {
						child.stdout.destroy();
						child.unref();
						throw new ProcessFailure({ message: 'CI process pipes did not drain after shutdown' });
					}
				}
			});
		}).pipe(Effect.ensuring(Effect.suspend(() => cleanup)));
	});

async function drainedWithin(exited: Promise<void>, milliseconds: number) {
	let timeout: ReturnType<typeof setTimeout>;
	try {
		return await Promise.race([
			exited.then(() => true),
			new Promise<boolean>((accept) => {
				timeout = setTimeout(() => accept(false), milliseconds);
			})
		]);
	} finally {
		clearTimeout(timeout!);
	}
}

function groupExists(group: number | undefined) {
	try {
		if (group) {
			process.kill(-group, 0);
			return true;
		}
	} catch {
		/* Already gone. */
	}
	return false;
}
async function groupRunning(group: number | undefined) {
	if (!groupExists(group)) return false;
	if (process.platform !== 'linux') return true;
	// Linux keeps dead orphan descendants as zombies until init reaps them.
	// They own no executing code/network; distinguish them from live survivors.
	const members = await readdir('/proc');
	const states = await Promise.all(
		members
			.filter((pid) => /^\d+$/.test(pid))
			.map(async (pid) => {
				try {
					const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
					const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
					return Number(fields[2]) === group && fields[0] !== 'Z';
				} catch {
					return false;
				}
			})
	);
	return states.some(Boolean);
}
async function groupStoppedWithin(group: number | undefined, milliseconds: number) {
	const deadline = Date.now() + milliseconds;
	while (await groupRunning(group)) {
		if (Date.now() >= deadline) return false;
		await new Promise((accept) => setTimeout(accept, 25));
	}
	return true;
}
