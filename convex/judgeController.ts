'use node';

import { Effect } from 'effect';
import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { judgeAttempt } from '../judge/controller';
import { modalProvider } from '../judge/modal';
import { runBackend, step, JudgeFailure } from './game/effect';
import { judgeCall, withModalClient } from './judgeSession';

const lease = { attemptId: v.id('judgeAttempts'), leaseVersion: v.number() };
const config = Effect.try({
	try: () => {
		const deployment = process.env.CONVEX_DEPLOYMENT;
		const appName = process.env.MODAL_APP_NAME;
		if (!deployment || !appName) throw new Error('JUDGE_CONFIG');
		return { deployment, appName };
	},
	catch: () => new JudgeFailure('JUDGE_CONFIG')
});

export const _run = internalAction({
	args: lease,
	handler: (ctx, args): Promise<void> =>
		runBackend(
			Effect.gen(function* () {
				const actionStartedAt = Date.now();
				let cleanupNotBefore = 0,
					cleanupConfirmed = false;
				const claim = yield* step(ctx.runMutation(internal.judge._claim, args));
				if (!claim) return;
				yield* Effect.gen(function* () {
					const { deployment, appName } = yield* config;
					yield* withModalClient((client) =>
						Effect.gen(function* () {
							const blob =
								'testsStorageId' in claim && claim.testsStorageId
									? yield* step(ctx.storage.get(claim.testsStorageId))
									: null;
							if (claim.kind === 'scored' && !blob)
								return yield* Effect.fail(new JudgeFailure('TEST_STORAGE'));
							if (blob && blob.size > 64 * 1024 * 1024)
								return yield* Effect.fail(new JudgeFailure('TEST_STORAGE_SIZE'));
							const bytes = blob ? new Uint8Array(yield* step(blob.arrayBuffer())) : undefined;
							yield* judgeCall(() =>
								judgeAttempt(
									claim,
									bytes,
									{
										create: (imageId, sandboxConfig) =>
											runBackend(
												Effect.gen(function* () {
													const sb = yield* judgeCall(() =>
														modalProvider(client, appName, undefined, () =>
															ctx.runMutation(internal.judge._beginCreate, args)
														).create(imageId, sandboxConfig)
													);
													return {
														...sb,
														terminate: () =>
															runBackend(
																Effect.gen(function* () {
																	yield* judgeCall(() => sb.terminate());
																	yield* step(
																		ctx.runMutation(internal.judge._confirmSandboxCleanup, {
																			sandboxId: sb.id,
																			lease: args
																		})
																	);
																	cleanupConfirmed = true;
																})
															)
													};
												})
											)
									},
									{
										noteSandbox: (sandboxId) =>
											runBackend(
												Effect.gen(function* () {
													const active = yield* step(
														ctx.runMutation(internal.judge._noteSandbox, { ...args, sandboxId })
													);
													// Later than the mutation's observation, so rounding and DB
													// acknowledgement latency cannot drop a normal completion.
													cleanupNotBefore = Date.now() + 41000;
													return active;
												})
											),
										noteStart: (stage) =>
											ctx.runMutation(internal.judge._noteContestantStart, { ...args, stage }),
										complete: (result) =>
											runBackend(
												Effect.gen(function* () {
													const remaining = cleanupNotBefore - Date.now();
													if (!cleanupConfirmed && remaining > 0) yield* Effect.sleep(remaining);
													return yield* step(
														ctx.runMutation(internal.judge._complete, { ...args, result })
													);
												})
											),
										fail: (failure) =>
											ctx.runMutation(internal.judge._fail, { ...args, ...failure }),
										retryTermination: (sandboxId) =>
											ctx.scheduler.runAfter(1000, internal.judgeController._terminate, {
												sandboxId,
												lease: args,
												retry: 1
											})
									},
									deployment,
									args.attemptId,
									actionStartedAt
								)
							);
						})
					);
				}).pipe(
					Effect.catchCause(() =>
						step(
							ctx.runMutation(internal.judge._fail, {
								...args,
								// Entry is not execution. Stored contestantStartedAt remains authoritative.
								failureClass: 'platform',
								code: 'CONTROLLER_FAILURE'
							})
						)
					)
				);
			})
		)
});

// Modal terminate acknowledges the request, while poll confirms the resource exited.
// Bound polling in the action; scheduler/reaper retries do not occupy a mutation.
function terminateAndConfirm(sandbox: {
	terminate(): Promise<void>;
	poll(): Promise<number | null>;
}) {
	return Effect.gen(function* () {
		yield* judgeCall(() => sandbox.terminate());
		const until = Date.now() + 2000;
		while ((yield* judgeCall(() => sandbox.poll())) === null) {
			if (Date.now() >= until) return yield* Effect.fail(new JudgeFailure('TERMINATION_PENDING'));
			yield* Effect.sleep(100);
		}
	});
}
export const _terminate = internalAction({
	args: {
		sandboxId: v.string(),
		retry: v.optional(v.number()),
		lease: v.optional(v.object(lease))
	},
	handler: (ctx, { sandboxId, retry = 0, lease: ownedLease }): Promise<void> =>
		runBackend(
			Effect.gen(function* () {
				if (!/^sb-[0-9A-Za-z]{22}$/.test(sandboxId)) return;
				yield* withModalClient((client) =>
					Effect.gen(function* () {
						const sandbox = yield* judgeCall(() => client.sandboxes.fromId(sandboxId));
						yield* terminateAndConfirm(sandbox);
						yield* step(
							ctx.runMutation(internal.judge._confirmSandboxCleanup, {
								sandboxId,
								...(ownedLease ? { lease: ownedLease } : {})
							})
						);
					})
				).pipe(
					Effect.catch(() =>
						Effect.gen(function* () {
							if (retry < 3)
								yield* step(
									ctx.scheduler.runAfter(1000 * 2 ** retry, internal.judgeController._terminate, {
										sandboxId,
										...(ownedLease ? { lease: ownedLease } : {}),
										retry: retry + 1
									})
								);
							// The independently scheduled reaper and 40 s lifetime remain backstops.
						})
					)
				);
			})
		)
});

/** Independent from attempt leases: cleans up leaked create results and failed terminations. */
export const _reap = internalAction({
	args: {},
	handler: (ctx): Promise<void> =>
		runBackend(
			Effect.gen(function* () {
				const { deployment, appName } = yield* config;
				const active = yield* step(ctx.runQuery(internal.judge._activeAttempts, {}));
				yield* withModalClient((client) =>
					Effect.gen(function* () {
						const app = yield* judgeCall(() => client.apps.fromName(appName));
						// A running-only list cannot recover an exit receipt lost after
						// termination. Revisit durable known IDs, including stopped sandboxes.
						const known = active
							.filter((a) => a.status === 'cleaning' && a.sandboxId)
							.slice(0, 100);
						for (const owner of known) {
							yield* Effect.gen(function* () {
								const sandboxId = owner.sandboxId!;
								const sb = yield* judgeCall(() => client.sandboxes.fromId(sandboxId));
								if ((yield* judgeCall(() => sb.poll())) === null) yield* terminateAndConfirm(sb);
								yield* step(
									ctx.runMutation(internal.judge._confirmSandboxCleanup, {
										sandboxId,
										lease: { attemptId: owner.attemptId, leaseVersion: owner.leaseVersion }
									})
								);
							}).pipe(Effect.catch(() => Effect.void));
						}

						const iterator = yield* Effect.try({
							try: () =>
								client.sandboxes
									.list({ appId: app.appId, tags: { app: 'beatcode', deployment } })
									[Symbol.asyncIterator](),
							catch: () => new JudgeFailure('JUDGE_TRANSPORT')
						});
						let exhausted = false;
						yield* Effect.acquireUseRelease(
							Effect.succeed(iterator),
							(entries) =>
								Effect.gen(function* () {
									let visited = known.length;
									while (true) {
										const next = yield* judgeCall(() => entries.next());
										if (next.done) {
											exhausted = true;
											break;
										}
										if (++visited > 100) break;
										const sandbox = next.value;
										const tags = yield* judgeCall(() => sandbox.getTags());
										const born = Number(tags.createdAtMs);
										const owner = active.find((a) => a.attemptId === tags.attemptId);
										if (owner?.status === 'cleaning')
											yield* step(
												ctx.runMutation(internal.judge._noteSandbox, {
													attemptId: owner.attemptId,
													leaseVersion: owner.leaseVersion,
													sandboxId: sandbox.sandboxId,
													creationConfirmed: false
												})
											);
										if (
											owner?.status === 'cleaning' ||
											!Number.isFinite(born) ||
											Date.now() - born > 45000
										) {
											yield* terminateAndConfirm(sandbox).pipe(
												Effect.andThen(() =>
													step(
														ctx.runMutation(internal.judge._confirmSandboxCleanup, {
															sandboxId: sandbox.sandboxId
														})
													)
												),
												Effect.catch(() => Effect.void)
											);
											// The next scheduled pass retries failed termination. Never log SDK errors.
										}
									}
								}),
							(entries) =>
								Effect.gen(function* () {
									if (!exhausted && entries.return)
										yield* judgeCall(() => entries.return!(undefined));
								})
						);
					})
				);
			})
		)
});
