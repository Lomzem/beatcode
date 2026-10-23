import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { Data, Effect } from 'effect';

const envFile = resolve('.scratch/competitive-leetcode/convex.dev.env');

class DevOperatorError extends Data.TaggedError('DevOperatorError')<{
	readonly message: string;
}> {}

export function devCall<T = unknown>(name: string, args: unknown) {
	return Effect.gen(function* () {
		const configuration = yield* Effect.try({
			try: () => readFileSync(envFile, 'utf8'),
			catch: () => new DevOperatorError({ message: 'DEV_DEPLOYMENT_REQUIRED' })
		});
		if (!/^CONVEX_DEPLOYMENT=['"]?dev:descriptive-scorpion-877\b/m.test(configuration))
			return yield* new DevOperatorError({ message: 'DEV_DEPLOYMENT_REQUIRED' });
		// Process exceptions may include hidden source and credentials in their arguments.
		const output = yield* Effect.try({
			try: () =>
				execFileSync(
					process.execPath,
					[
						'node_modules/convex/bin/main.js',
						'run',
						'--env-file',
						envFile,
						'--typecheck',
						'disable',
						name,
						JSON.stringify(args)
					],
					{ encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
				),
			catch: () => new DevOperatorError({ message: `DEV_OPERATOR_CALL_FAILED:${name}` })
		});
		// Convex intentionally prints no result for successful void mutations.
		if (!output.trim()) return undefined as T;
		return yield* Effect.try({
			try: () => JSON.parse(output) as T,
			catch: () => new DevOperatorError({ message: `DEV_OPERATOR_OUTPUT_INVALID:${name}` })
		});
	});
}

/** Synchronous CLI boundary; call sites retain their existing return contract. */
export function devRun<T>(name: string, args: unknown): T {
	return Effect.runSync(devCall<T>(name, args));
}
