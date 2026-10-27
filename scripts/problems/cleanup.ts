import { writeFileSync, mkdirSync } from 'node:fs';
import { Effect } from 'effect';
import { modalClient } from '../../judge/modal.ts';
import { OperatorError, operatorAsync, operatorSync } from './effects.ts';

const cleanup = Effect.scoped(
	Effect.gen(function* () {
		const client = yield* Effect.acquireRelease(
			operatorSync('MODAL_CONFIG_REQUIRED', () => modalClient()),
			(client) => operatorSync('MODAL_CLIENT_CLOSE_FAILED', () => client.close()).pipe(Effect.orDie)
		);
		const app = yield* operatorAsync('CALIBRATION_APP_REQUIRED', () =>
			client.apps.fromName('beatcode-calibration-dev-20261023')
		);
		const list = () =>
			operatorAsync('CALIBRATION_LIST_FAILED', async () => {
				const sandboxes = [];
				for await (const sandbox of client.sandboxes.list({ appId: app.appId }))
					sandboxes.push(sandbox);
				return sandboxes;
			});
		const terminated: string[] = [];
		for (const sandbox of yield* list()) {
			const state = yield* operatorAsync('CALIBRATION_POLL_FAILED', () => sandbox.poll());
			if (state === null) {
				yield* operatorAsync('CALIBRATION_TERMINATE_FAILED', () => sandbox.terminate());
				terminated.push(sandbox.sandboxId);
			}
		}
		let running = 0;
		for (const sandbox of yield* list()) {
			if ((yield* operatorAsync('CALIBRATION_POLL_FAILED', () => sandbox.poll())) === null)
				running++;
		}
		const evidence = { at: new Date().toISOString(), appId: app.appId, terminated, running };
		yield* operatorSync('CLEANUP_EVIDENCE_WRITE_FAILED', () => {
			mkdirSync('.scratch/competitive-leetcode/calibration', { recursive: true, mode: 0o700 });
			writeFileSync(
				'.scratch/competitive-leetcode/calibration/cleanup.json',
				JSON.stringify(evidence, null, 2),
				{ mode: 0o600 }
			);
		});
		console.log(JSON.stringify(evidence));
		if (running) return yield* new OperatorError({ message: 'CALIBRATION_CLEANUP' });
	})
);

await Effect.runPromise(cleanup);
