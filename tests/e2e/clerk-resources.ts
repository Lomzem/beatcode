import { Effect, Data, Result } from 'effect';
import { mkdir, writeFile, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CI_BACKEND_URL } from './deployment';
import { recoveryCall } from './recovery-store';

export class AccountResourceFailure extends Data.TaggedError('AccountResourceFailure')<{
	message: string;
}> {}
const operation = <A>(run: () => Promise<A>, message: string) =>
	Effect.tryPromise({ try: run, catch: () => new AccountResourceFailure({ message }) });
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
type Run = { runId: string; startedAt: number; backend: string };
type Intent = Run & {
	accountId: string;
	requestedAt: number;
	state: 'planned' | 'created' | 'rejected' | 'deleted';
	clerkId?: string;
};
type User = {
	id: string;
	external_id: string;
	created_at: number;
	email_addresses: { email_address: string }[];
	private_metadata: Record<string, unknown>;
};
const emailFor = (accountId: string) => `beatcode-ci-${accountId}+clerk_test@example.com`;
const externalId = (intent: Intent) => `beatcode-ci:${intent.runId}:${intent.accountId}`;
const persist = (directory: string, name: string, data: Run | Intent) =>
	operation(async () => {
		// Remote commit precedes Clerk POST and survives hosted-runner destruction.
		if ('accountId' in data) await recoveryCall('put', { intent: data });
		// Local private cache is independently removable; it is not the durable owner.
		const temporary = join(directory, name + '.writing');
		await writeFile(temporary, JSON.stringify(data), { mode: 0o600, flush: true });
		await rename(temporary, join(directory, name));
	}, 'CI account recovery record failed');
const loadRun = (directory: string) =>
	operation(async () => {
		const run = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8')) as Run;
		if (
			!uuid.test(run.runId) ||
			basename(directory) !== run.runId ||
			run.backend !== CI_BACKEND_URL ||
			!Number.isFinite(run.startedAt)
		)
			throw new Error('Invalid recovery run');
		return run;
	}, 'CI account recovery identity invalid');
const request = (path: string, init: RequestInit = {}, deadline = Date.now() + 5000) =>
	operation(async () => {
		if (!process.env.CLERK_CI_SECRET_KEY?.startsWith('sk_test_') || Date.now() >= deadline)
			throw new Error('DEV credential or cleanup budget unavailable');
		return await fetch(`https://api.clerk.com/v1/${path}`, {
			...init,
			signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))),
			headers: {
				Authorization: `Bearer ${process.env.CLERK_CI_SECRET_KEY}`,
				'Content-Type': 'application/json'
			}
		});
	}, 'Clerk DEV resource request failed');
const json = <A>(response: Response) =>
	operation(async () => {
		if (!response.ok) throw new Error('Clerk DEV resource request refused');
		return (await response.json()) as A;
	}, 'Clerk DEV resource response failed');

export const openAccountRun = (base: string) =>
	Effect.gen(function* () {
		const run: Run = { runId: randomUUID(), startedAt: Date.now(), backend: CI_BACKEND_URL };
		const directory = join(base, run.runId);
		yield* operation(
			() => mkdir(directory, { recursive: true, mode: 0o700 }),
			'CI account recovery workspace failed'
		);
		yield* persist(directory, 'run.json', run);
		return directory;
	});

export const createDevAccount = (directory: string) =>
	Effect.uninterruptible(
		Effect.gen(function* () {
			const run = yield* loadRun(directory);
			const intent: Intent = {
				...run,
				accountId: randomUUID(),
				requestedAt: Date.now(),
				state: 'planned'
			};
			const name = intent.accountId + '.intent.json';
			// This is committed BEFORE issuing the network request. Even SIGKILL between
			// remote commit and response leaves exact fresh selectors for reconciliation.
			yield* persist(directory, name, intent);
			const email = emailFor(intent.accountId);
			const response = yield* request('users', {
				method: 'POST',
				body: JSON.stringify({
					email_address: [email],
					skip_password_requirement: true,
					external_id: externalId(intent),
					private_metadata: {
						beatcode_ci_run: run.runId,
						beatcode_ci_account: intent.accountId,
						beatcode_ci_backend: CI_BACKEND_URL
					}
				})
			});
			if (response.status >= 400 && response.status < 500 && response.status !== 408) {
				yield* persist(directory, name, { ...intent, state: 'rejected' });
			}
			const user = yield* json<{ id: string }>(response);
			yield* persist(directory, name, { ...intent, state: 'created', clerkId: user.id });
			return email;
		})
	);

function belongs(user: User, intent: Intent) {
	return (
		user.external_id === externalId(intent) &&
		user.private_metadata?.beatcode_ci_run === intent.runId &&
		user.private_metadata?.beatcode_ci_account === intent.accountId &&
		user.private_metadata?.beatcode_ci_backend === CI_BACKEND_URL &&
		user.created_at >= intent.requestedAt - 60000 &&
		user.created_at <= Date.now() + 60000 &&
		user.email_addresses?.some((email) => email.email_address === emailFor(intent.accountId))
	);
}
const deleteOwnedUser = (user: User, deadline: number) =>
	Effect.gen(function* () {
		let deleted = false;
		for (let retry = 0; retry < 3 && Date.now() < deadline; retry++) {
			const result = yield* request(
				`users/${encodeURIComponent(user.id)}`,
				{ method: 'DELETE' },
				deadline
			).pipe(Effect.result);
			if (Result.isSuccess(result) && (result.success.ok || result.success.status === 404)) {
				deleted = true;
				break;
			}
			if (retry < 2 && Date.now() + 500 < deadline) yield* Effect.sleep(500);
		}
		if (!deleted)
			return yield* Effect.fail(
				new AccountResourceFailure({
					message: 'CI account deletion unresolved; private recovery intent retained'
				})
			);
	});
const reconcile = (directory: string, name: string, run: Run, deadline: number) =>
	Effect.gen(function* () {
		const intent = yield* operation(async () => {
			const data = JSON.parse(await readFile(join(directory, name), 'utf8')) as Intent;
			if (
				data.runId !== run.runId ||
				data.backend !== CI_BACKEND_URL ||
				!uuid.test(data.accountId) ||
				name !== data.accountId + '.intent.json' ||
				data.startedAt !== run.startedAt ||
				!Number.isFinite(data.requestedAt) ||
				data.requestedAt < run.startedAt ||
				!['planned', 'created', 'rejected', 'deleted'].includes(data.state)
			)
				throw new Error('Invalid intent');
			return data;
		}, 'CI account recovery intent invalid');
		if (intent.state === 'deleted' || intent.state === 'rejected') return;
		if (intent.clerkId) {
			const response = yield* request(`users/${encodeURIComponent(intent.clerkId)}`, {}, deadline);
			if (response.status !== 404) {
				const user = yield* json<User>(response);
				if (user?.id !== intent.clerkId || !belongs(user, intent))
					return yield* Effect.fail(
						new AccountResourceFailure({
							message: 'CI known account ownership mismatch; recovery retained'
						})
					);
				yield* deleteOwnedUser(user, deadline);
			}
			yield* persist(directory, name, { ...intent, state: 'deleted' });
			return;
		}
		if (intent.state === 'created')
			return yield* Effect.fail(
				new AccountResourceFailure({ message: 'CI known account ID missing; recovery retained' })
			);

		let found = false;
		// Allow an ambiguous POST to settle after the creator has drained or died.
		for (let attempt = 0; attempt < (intent.state === 'planned' ? 5 : 1); attempt++) {
			const response = yield* request(
				`users?external_id=${encodeURIComponent(externalId(intent))}&limit=100`,
				{},
				deadline
			);
			const users = yield* json<User[]>(response);
			if (!Array.isArray(users))
				return yield* Effect.fail(
					new AccountResourceFailure({ message: 'CI account reconciliation response invalid' })
				);
			if (users.some((user) => user.external_id === externalId(intent) && !belongs(user, intent)))
				return yield* Effect.fail(
					new AccountResourceFailure({
						message: 'CI recovery ownership mismatch; no account deleted'
					})
				);
			const own = users.filter((user) => belongs(user, intent));
			for (const user of own) {
				yield* deleteOwnedUser(user, deadline);
				found = true;
			}
			if (found) {
				yield* persist(directory, name, { ...intent, state: 'deleted' });
				return;
			}
			if (attempt < 4 && Date.now() + 1000 < deadline) yield* Effect.sleep(1000);
		}
		return yield* Effect.fail(
			new AccountResourceFailure({
				message: 'CI account creation outcome unresolved; private recovery intent retained'
			})
		);
	});

export const cleanupAccountRun = (directory: string) =>
	Effect.gen(function* () {
		const run = yield* loadRun(directory);
		const names = yield* operation(() => readdir(directory), 'CI account recovery list failed');
		const deadline = Date.now() + 30000;
		const outcomes = yield* Effect.forEach(
			names.filter((name) => name.endsWith('.intent.json')),
			(name) => reconcile(directory, name, run, deadline).pipe(Effect.result),
			{ concurrency: 3 }
		);
		if (outcomes.some(Result.isFailure))
			return yield* Effect.fail(
				new AccountResourceFailure({
					message: 'CI account cleanup incomplete; private noncredential recovery retained'
				})
			);
		for (const name of names.filter((name) => name.endsWith('.intent.json'))) {
			const intent = yield* operation(
				async () => JSON.parse(await readFile(join(directory, name), 'utf8')) as Intent,
				'CI recovery completion unavailable'
			);
			yield* operation(
				() => recoveryCall('remove', { runId: run.runId, accountId: intent.accountId }),
				'CI durable recovery removal failed'
			);
		}
		yield* operation(
			() => rm(directory, { recursive: true, force: true }),
			'CI account recovery removal failed'
		);
	});

export const recoverAccountRuns = (base: string) =>
	Effect.gen(function* () {
		yield* operation(
			() => mkdir(base, { recursive: true, mode: 0o700 }),
			'CI account recovery base failed'
		);
		const remote = yield* operation(async () => {
			const rows = await recoveryCall('list', {});
			if (!Array.isArray(rows)) throw new Error('Invalid recovery list');
			return rows as Intent[];
		}, 'CI durable recovery unavailable; account creation blocked');
		for (const intent of remote) {
			if (
				!uuid.test(intent.runId) ||
				!uuid.test(intent.accountId) ||
				intent.backend !== CI_BACKEND_URL
			)
				return yield* Effect.fail(
					new AccountResourceFailure({ message: 'CI durable recovery identity invalid' })
				);
			const directory = join(base, intent.runId);
			yield* operation(
				() => mkdir(directory, { recursive: true, mode: 0o700 }),
				'CI recovery restore failed'
			);
			yield* persist(directory, 'run.json', {
				runId: intent.runId,
				startedAt: intent.startedAt,
				backend: intent.backend
			});
			yield* persist(directory, intent.accountId + '.intent.json', intent);
		}
		const names = yield* operation(() => readdir(base), 'CI account recovery base unavailable');
		for (const name of names.filter((name) => uuid.test(name)))
			yield* cleanupAccountRun(join(base, name));
	});
