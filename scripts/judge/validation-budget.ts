// Operator-only validation accounting. Reservations are durable before every create/build.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ModalClient } from 'modal';
import { Effect } from 'effect';
import { OperatorError, operatorSync, operatorAsync } from '../problems/effects.ts';

export const evidenceDir = resolve('.scratch/competitive-leetcode/judge-validation');
const ledger = resolve(evidenceDir, 'ledger.jsonl');
export const validationApp = () => {
	if (process.env.MODAL_APP_NAME !== 'beatcode-judge-validation-20261023')
		throw new Error('VALIDATION_APP_SCOPE');
	if (
		process.env.MODAL_CONFIG_PATH !==
		resolve('.scratch/competitive-leetcode/.modal-production.toml')
	)
		throw new Error('VALIDATION_CONFIG_PATH');
	return process.env.MODAL_APP_NAME;
};
function recordEffect(row: Record<string, unknown>) {
	return Effect.gen(function* () {
		yield* operatorSync('VALIDATION_LEDGER_WRITE', () =>
			mkdirSync(evidenceDir, { recursive: true })
		);
		yield* operatorSync('VALIDATION_LEDGER_WRITE', () =>
			appendFileSync(ledger, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n', {
				mode: 0o600
			})
		);
	});
}
export function record(row: Record<string, unknown>) {
	return Effect.runSync(recordEffect(row));
}
export function reserve(label: string, seconds = 40, builder = false) {
	return Effect.runSync(
		Effect.gen(function* () {
			yield* operatorSync('VALIDATION_CONFIG', validationApp);
			const rows = yield* operatorSync('VALIDATION_LEDGER_READ', () =>
				existsSync(ledger)
					? readFileSync(ledger, 'utf8')
							.trim()
							.split('\n')
							.filter(Boolean)
							.map((s) => JSON.parse(s))
					: []
			);
			const reserved = rows.reduce((n, r) => n + (r.reservedSeconds ?? 0), 0);
			const dollars = rows.reduce((n, r) => n + (r.creditEstimate ?? 0), 0);
			// Builder reservation conservatively covers8cores/32GiB; sandbox reserves1core/0.75GiB.
			const creditEstimate =
				seconds *
				(builder
					? (8 * 0.1419) / 3600 + (32 * 0.024) / 3600
					: 0.1419 / 3600 + (0.75 * 0.024) / 3600);
			// Approved repair allocations retain every charge, including failed qualification.
			// The existing $1 validation ceiling and $0 net-spend policy remain in force.
			if (reserved + seconds > 7660 || dollars + creditEstimate > 1)
				return yield* new OperatorError({ message: 'VALIDATION_BUDGET' });
			yield* recordEffect({
				event: 'reserved',
				label,
				reservedSeconds: seconds,
				creditEstimate,
				builder
			});
		})
	);
}
export function reaper(client: ModalClient, label: string) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const name = yield* operatorSync('VALIDATION_CONFIG', validationApp);
			const app = yield* operatorAsync('VALIDATION_APP', () => client.apps.fromName(name));
			const list = () =>
				operatorAsync('VALIDATION_LIST', async () => {
					const sandboxes = [];
					for await (const sandbox of client.sandboxes.list({ appId: app.appId }))
						sandboxes.push(sandbox);
					return sandboxes;
				});
			const ids: string[] = [];
			for (const sandbox of yield* list()) {
				ids.push(sandbox.sandboxId);
				yield* operatorAsync('VALIDATION_TERMINATE', () => sandbox.terminate());
			}
			let running = 0;
			for (const sandbox of yield* list())
				if ((yield* operatorAsync('VALIDATION_POLL', () => sandbox.poll())) === null) running++;
			const result = { at: new Date().toISOString(), appId: app.appId, terminated: ids, running };
			yield* operatorSync('VALIDATION_EVIDENCE_WRITE', () =>
				writeFileSync(
					resolve(evidenceDir, `cleanup-${label}.json`),
					JSON.stringify(result, null, 2) + '\n'
				)
			);
			yield* recordEffect({ event: 'reaper', label, ...result });
			if (running !== 0) return yield* new OperatorError({ message: 'VALIDATION_CLEANUP' });
		})
	);
}
