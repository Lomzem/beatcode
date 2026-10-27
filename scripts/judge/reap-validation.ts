// Independent operator invocation, scoped to the dedicated validation app.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Effect } from 'effect';
import { modalClient } from '../../judge/modal.ts';
import { evidenceDir, reaper } from './validation-budget.ts';
import { OperatorError, operatorAsync, operatorSync } from '../problems/effects.ts';

const reap = Effect.scoped(
	Effect.gen(function* () {
		const client = yield* Effect.acquireRelease(
			operatorSync('MODAL_CONFIG', modalClient),
			(client) => operatorSync('MODAL_CLOSE', () => client.close()).pipe(Effect.orDie)
		);
		yield* operatorAsync('VALIDATION_REAPER', () => reaper(client, 'independent'));
		const rows = yield* operatorSync('VALIDATION_LEDGER_READ', () =>
			readFileSync(resolve(evidenceDir, 'ledger.jsonl'), 'utf8')
				.trim()
				.split('\n')
				.map((s) => JSON.parse(s))
		);
		const ids = [...new Set<string>(rows.filter((r) => r.event === 'created').map((r) => r.id))];
		const sandboxes = [];
		for (const id of ids) {
			const sandbox = yield* operatorAsync('VALIDATION_SANDBOX', () => client.sandboxes.fromId(id));
			const code = yield* operatorAsync('VALIDATION_POLL', () => sandbox.poll());
			const usage = yield* operatorAsync('VALIDATION_USAGE', () =>
				client.cpClient.sandboxGetResourceUsage({ sandboxId: id })
			);
			sandboxes.push({
				id,
				finished: code !== null,
				exitCode: code,
				coreSeconds: Number(usage.cpuCoreNanosecs) / 1e9,
				memoryGiBSeconds: Number(usage.memGibNanosecs) / 1e9
			});
		}
		const report = {
			at: new Date().toISOString(),
			reservedSeconds: rows.reduce((n, r) => n + (r.reservedSeconds ?? 0), 0),
			creditEstimate: rows.reduce((n, r) => n + (r.creditEstimate ?? 0), 0),
			allFinished: sandboxes.every((s) => s.finished),
			sandboxes
		};
		yield* operatorSync('VALIDATION_EVIDENCE_WRITE', () =>
			writeFileSync(resolve(evidenceDir, 'usage.json'), JSON.stringify(report, null, 2) + '\n')
		);
		if (!report.allFinished) return yield* new OperatorError({ message: 'VALIDATION_UNFINISHED' });
	})
);

await Effect.runPromise(reap);
