'use node';
import { Effect } from 'effect';
import { deploymentConfig } from './calibrationConfig';
import { runBackend, step, CalibrationFailure } from './game/effect';
import { v } from 'convex/values';
import { decisionPolicy, ALL_HISTORY_POLICY, ALL_HISTORY_POLICY_SPEC } from './game/validators';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import {
	EXECUTION_POLICY,
	logicalSamples,
	retryApproval,
	type Measurement
} from './calibrationState';
const role = v.union(
	v.literal('validator'),
	v.literal('accepted'),
	v.literal('timeLimitExceeded'),
	v.literal('wrongAnswer'),
	v.literal('slowSample')
);
import {
	judgeCalibrationReference,
	sha256,
	environmentBinding,
	type Result,
	type SandboxProvider,
	type TestCase
} from '../judge/controller';
import { modalProvider } from '../judge/modal';
import { withModalClient } from './judgeSession';

const calibrationTransport = <A>(operation: () => PromiseLike<A>) =>
	Effect.tryPromise({
		try: operation,
		catch: () => new CalibrationFailure('CALIBRATION_TRANSPORT')
	});

// Each execution remains a valid contestant package. No input is dropped from index 0;
// index 1 uses only small public inputs plus the four required negative controls.
function validatorExecution(original: string, blob: Uint8Array, index: number) {
	if (index !== 0 && index !== 1) throw new Error('CALIBRATION_JOB');
	const parsed = JSON.parse(
		gunzipSync(blob, { maxOutputLength: 96 * 1024 * 1024 }).toString('utf8')
	);
	if (parsed.format !== 'beatcode-tests/1' || !Array.isArray(parsed.tests))
		throw new Error('CALIBRATION_TESTS');
	const valid = parsed.tests as TestCase[];
	const publicTests = valid.filter((t) => t.kind === 'sample');
	const first = publicTests[0]?.input;
	if (typeof first !== 'string') throw new Error('CALIBRATION_TESTS');
	const tokens = first.trim().split(/\s+/);
	const controls = [
		'',
		tokens.slice(0, -1).join(' '),
		first + '\nTRAILING_INVALID\n',
		['0', ...tokens.slice(1)].join(' ')
	];
	const tests =
		index === 0
			? valid.map((t) => ({ ...t, answer: 'VALID' }))
			: [
					...publicTests.map((t) => ({ ...t, answer: 'VALID' })),
					...controls.map((input, i) => ({
						name: `control-${i}`,
						input,
						answer: 'INVALID',
						kind: 'secret' as const
					})),
					...Array.from({ length: 6 }, (_, i) => ({
						name: `valid-${i}`,
						input: first,
						answer: 'VALID',
						kind: 'secret' as const
					}))
				];
	return {
		// Preserve the original exit-42 convention without accepting a malformed control.
		source:
			'#define main beatcode_validator_main\n' +
			original +
			'\n#undef main\nint main(){int code=beatcode_validator_main();std::cout<<(code==42?"VALID":"INVALID");return 0;}\n',
		samples: tests
			.filter((t) => t.kind === 'sample')
			.map((t) => ({ input: t.input, output: t.answer })),
		blob: new Uint8Array(gzipSync(JSON.stringify({ format: 'beatcode-tests/1', tests })))
	};
}

// Package parsing is pure, but invalid trusted package data is an expected failure.
function validatedExecution(original: string, blob: Uint8Array, index: number) {
	return Effect.try({
		try: () => validatorExecution(original, blob, index),
		catch: () =>
			new CalibrationFailure(index === 0 || index === 1 ? 'CALIBRATION_TESTS' : 'CALIBRATION_JOB')
	});
}

export const _job = internalAction({
	args: {
		problemVersionId: v.id('problemVersions'),
		role,
		index: v.number(),
		repeat: v.number(),
		retryOf: v.optional(v.id('auditLog')),
		retryApproval: v.optional(retryApproval),
		decisionPolicy: v.optional(decisionPolicy)
	},
	handler: (ctx, args): Promise<Measurement> =>
		runBackend(
			Effect.gen(function* () {
				const started = Date.now();
				const deployment = yield* deploymentConfig(true);
				const input = yield* step(
					ctx.runQuery(internal.problems._calibrationInput, {
						problemVersionId: args.problemVersionId,
						...(args.decisionPolicy ? { decisionPolicy: args.decisionPolicy } : {})
					})
				);
				if (!input?.environment || !input.version.referenceSolutions)
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_INPUT'));
				const { version: p, environment: e } = input,
					refs = p.referenceSolutions!;
				if (
					deployment.production &&
					(!p.productionBaseline || !e.productionApp || args.decisionPolicy !== ALL_HISTORY_POLICY)
				)
					return yield* Effect.fail(new CalibrationFailure('PRODUCTION_BASELINE_REQUIRED'));
				const original =
					args.role === 'validator'
						? refs.validator
						: args.role === 'slowSample'
							? refs.timeLimitExceeded[args.index]
							: refs[args.role][args.index];
				if (!original) return yield* Effect.fail(new CalibrationFailure('CALIBRATION_SOURCE'));
				const reservationId = yield* step(
					ctx.runMutation(internal.calibrationState._reserve, {
						...args,
						sourceSha256: sha256(original)
					})
				);
				let result: Measurement = {
					verdict: 'ERROR',
					slowestTestMs: 0,
					aggregateMs: 0,
					attemptWallMs: 0,
					testWallMs: [],
					execObservedMs: [],
					sandboxSeconds: 40,
					actionSeconds: 0,
					sourceSha256: sha256(original),
					executionTestsSha256: p.testsSha256
				};
				yield* Effect.onExit(
					Effect.gen(function* () {
						const stored = yield* step(ctx.storage.get(p.testsStorageId));
						if (!stored || stored.size > 32 * 1024 * 1024)
							return yield* Effect.fail(new CalibrationFailure('CALIBRATION_STORAGE'));
						let blob = new Uint8Array(yield* step(stored.arrayBuffer()));
						if (sha256(blob) !== p.testsSha256)
							return yield* Effect.fail(new CalibrationFailure('CALIBRATION_TEST_BINDING'));
						let source = original,
							samples = p.samples;
						if (args.role === 'validator') {
							({ source, samples, blob } = yield* validatedExecution(original, blob, args.index));
						}
						result.sourceSha256 = sha256(source);
						result.executionTestsSha256 = sha256(blob);
						let completed: Result | undefined;
						yield* withModalClient((client) =>
							Effect.gen(function* () {
								if (deployment.production) {
									const app = yield* calibrationTransport(() =>
										client.apps.fromName(deployment.appName)
									);
									if (app.appId !== e.productionApp!.appId)
										return yield* Effect.fail(new CalibrationFailure('CALIBRATION_APP_BINDING'));
								}
								const rawProvider = modalProvider(
									client,
									process.env.MODAL_APP_NAME!,
									deployment.production ? e.productionApp!.appId : undefined
								);
								const provider: SandboxProvider = {
									create: (imageId, config) =>
										runBackend(
											Effect.gen(function* () {
												const allowed = yield* step(
													ctx.runMutation(internal.calibrationState._creating, { reservationId })
												);
												if (!allowed)
													return yield* Effect.fail(
														new CalibrationFailure('CALIBRATION_RESERVATION')
													);
												const sb = yield* step(
													rawProvider.create(imageId, {
														...config,
														tags: {
															...config.tags,
															...(deployment.production
																? { calibrationAppId: e.productionApp!.appId }
																: {})
														}
													})
												);
												yield* step(
													ctx.runMutation(internal.calibrationState._created, {
														reservationId,
														sandboxId: sb.id
													})
												);
												return {
													...sb,
													terminate: () =>
														runBackend(
															Effect.gen(function* () {
																yield* calibrationTransport(() => sb.terminate());
																yield* step(
																	ctx.runMutation(internal.calibrationState._terminated, {
																		reservationId,
																		sandboxId: sb.id
																	})
																);
															})
														)
												};
											})
										)
								};
								const alive = () =>
									ctx.runMutation(internal.calibrationState._alive, { reservationId });
								yield* step(
									judgeCalibrationReference(
										{
											kind: args.role === 'slowSample' ? 'sample' : 'scored',
											source,
											samples,
											limits: { ...p.limits, timeMs: 10000 },
											snapshot: {
												profile: 'std',
												judgeEnvId: e._id,
												sourceSha256: sha256(source),
												testsSha256: sha256(blob),
												environmentSha256: environmentBinding(e)
											},
											testsSha256: sha256(blob),
											environment: e,
											ceilingAt: started + 90000
										},
										blob,
										provider,
										{
											noteSandbox: alive,
											noteStart: alive,
											complete: async (r) => {
												completed = r;
											},
											fail: async (failure) => {
												// Copy a typed whitelist, never an SDK exception or sandbox text.
												if (failure.failureClass === 'sandbox_lost' && failure.code === 'EXEC_LOST')
													result.failure = {
														failureClass: 'sandbox_lost',
														code: 'EXEC_LOST',
														timedOut: failure.timedOut === true,
														lowMemory: failure.lowMemory === true
													};
												else if (
													failure.failureClass === 'platform' &&
													failure.code === 'CONTROLLER_PREFLIGHT'
												)
													result.failure = {
														failureClass: 'platform',
														code: 'CONTROLLER_PREFLIGHT'
													};
											},
											retryTermination: async (sandboxId) => {
												await ctx.scheduler.runAfter(1000, internal.calibration._cleanup, {
													reservationId
												});
												void sandboxId;
											}
										},
										deployment.deployment,
										String(reservationId),
										started
									)
								);
								if (completed) {
									const r = completed as Result;
									result = {
										...result,
										verdict: r.verdict,
										slowestTestMs: Math.max(0, ...r.metrics.testWallMs),
										aggregateMs: r.metrics.testWallMs.reduce((a, b) => a + b, 0),
										attemptWallMs: r.sandboxSeconds * 1000,
										testWallMs: r.metrics.testWallMs,
										execObservedMs: r.metrics.execObservedMs,
										sandboxSeconds: r.sandboxSeconds,
										actionSeconds: r.actionSeconds
									};
								}
							})
						);
					}),
					() =>
						Effect.gen(function* () {
							result.actionSeconds = (Date.now() - started) / 1000;
							yield* step(
								ctx.runMutation(internal.calibrationState._finish, { reservationId, result })
							);
						})
				);
				return result;
			})
		)
});
function finalize(production: boolean) {
	return (
		ctx: ActionCtx,
		a: { problemVersionId: Id<'problemVersions'>; decisionPolicy?: typeof ALL_HISTORY_POLICY }
	): Promise<{ activated: boolean; evidenceSha256: string }> =>
		runBackend(
			Effect.gen(function* () {
				const deployment = yield* deploymentConfig();
				if (deployment.production !== production)
					return yield* Effect.fail(new CalibrationFailure('PRODUCTION_PHASE6_REQUIRED'));
				const input = yield* step(ctx.runQuery(internal.problems._calibrationInput, a));
				if (!input?.environment || !input.version.referenceSolutions)
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_INPUT'));
				const p = input.version,
					refs = p.referenceSolutions!;
				if (production && (!p.productionBaseline || !input.environment.productionApp))
					return yield* Effect.fail(new CalibrationFailure('PRODUCTION_BASELINE_REQUIRED'));
				const status = yield* step(ctx.runQuery(internal.calibrationState._status, {}));
				if (
					status.jobs.some(
						(j) => j.problemVersionId === p._id && j.executionPolicy !== EXECUTION_POLICY
					)
				)
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_POLICY'));
				const allHistory = a.decisionPolicy === ALL_HISTORY_POLICY;
				if (
					allHistory &&
					status.jobs.some(
						(j) =>
							j.problemVersionId === p._id &&
							(j.packageSha256 !== p.packageSha256 || j.testsSha256 !== p.testsSha256)
					)
				)
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_TEST_BINDING'));
				const jobs = status.jobs.filter(
					(j) =>
						j.problemVersionId === p._id &&
						j.packageSha256 === p.packageSha256 &&
						j.testsSha256 === p.testsSha256
				);
				if (
					production &&
					jobs.some(
						(j) =>
							j.deployment !== deployment.deployment ||
							j.appId !== input.environment!.productionApp!.appId ||
							!j.environmentSha256
					)
				)
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_ENVIRONMENT'));
				const expectedEnvironment = environmentBinding(input.environment);
				if (jobs.some((j) => j.environmentSha256 && j.environmentSha256 !== expectedEnvironment))
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_ENVIRONMENT'));
				if (jobs.some((j) => !j.released))
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_PENDING'));
				const stored = yield* step(ctx.storage.get(p.testsStorageId));
				if (!stored || stored.size > 32 * 1024 * 1024)
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_STORAGE'));
				const blob = new Uint8Array(yield* step(stored.arrayBuffer()));
				if (sha256(blob) !== p.testsSha256)
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_TEST_BINDING'));
				const validatorExecutions = yield* Effect.forEach([0, 1], (index) =>
					validatedExecution(refs.validator, blob, index)
				);
				if (
					allHistory &&
					jobs.some((j) => {
						const original =
							j.role === 'validator'
								? refs.validator
								: j.role === 'slowSample'
									? refs.timeLimitExceeded[j.index]
									: refs[j.role as 'accepted' | 'timeLimitExceeded' | 'wrongAnswer']?.[j.index];
						return !original || j.sourceSha256 !== sha256(original);
					})
				)
					return yield* Effect.fail(new CalibrationFailure('CALIBRATION_EVIDENCE'));
				const logical = yield* logicalSamples(jobs);
				const suiteCount = yield* Effect.try({
					try: () =>
						(
							JSON.parse(gunzipSync(blob, { maxOutputLength: 96 * 1024 * 1024 }).toString('utf8'))
								.tests as TestCase[]
						).length,
					catch: () => new CalibrationFailure('CALIBRATION_TESTS')
				});
				if (allHistory) {
					for (const j of logical) {
						const source =
							j.role === 'validator'
								? refs.validator
								: j.role === 'slowSample'
									? refs.timeLimitExceeded[j.index]
									: refs[j.role as 'accepted' | 'timeLimitExceeded' | 'wrongAnswer']?.[j.index];
						const execution =
							j.role === 'validator' ? validatorExecutions[j.index] : { source, blob };
						if (
							!source ||
							!execution ||
							j.sourceSha256 !== sha256(source) ||
							!j.result ||
							j.result.sourceSha256 !== sha256(execution.source) ||
							j.result.executionTestsSha256 !== sha256(execution.blob) ||
							j.expired ||
							j.creation !== 'stopped'
						)
							return yield* Effect.fail(new CalibrationFailure('CALIBRATION_EVIDENCE'));
					}
				}
				const measured = (r: Measurement, complete: boolean, count = suiteCount) =>
					r.testWallMs.length > 0 &&
					r.testWallMs.length === r.execObservedMs.length &&
					(!complete || r.testWallMs.length === count) &&
					r.testWallMs.length <= count &&
					[...r.testWallMs, ...r.execObservedMs, r.attemptWallMs].every(
						(n) => Number.isFinite(n) && n > 0
					) &&
					r.slowestTestMs === Math.max(...r.testWallMs) &&
					r.aggregateMs === r.testWallMs.reduce((sum, n) => sum + n, 0);

				const results = (role: string, index: number) => {
					const original =
						role === 'validator'
							? refs.validator
							: role === 'slowSample'
								? refs.timeLimitExceeded[index]
								: refs[role as 'accepted' | 'timeLimitExceeded' | 'wrongAnswer'][index];
					const execution =
						role === 'validator' ? validatorExecutions[index] : { source: original, blob };
					return logical
						.filter((j) => j.role === role && j.index === index)
						.sort((a, b) => a.repeat - b.repeat)
						.flatMap((j) =>
							j.result &&
							j.sourceSha256 === sha256(original) &&
							j.result.sourceSha256 === sha256(execution.source) &&
							j.result.executionTestsSha256 === sha256(execution.blob)
								? [j.result]
								: []
						);
				};
				const accepted = refs.accepted.map((_, i) => {
					const all = results('accepted', i);
					const r = allHistory ? all : all.length > 8 ? all.slice(8) : all;
					return {
						passed: r.map((x) => x.verdict === 'AC' && (!allHistory || measured(x, true))),
						slowestTestMs: r.map((x) => x.slowestTestMs),
						aggregateMs: r.map((x) => x.aggregateMs),
						attemptWallMs: r.map((x) => x.attemptWallMs)
					};
				});
				const evidenceSha256 = sha256(JSON.stringify(jobs));
				const calibration = {
					...(allHistory
						? {
								decisionPolicy: {
									name: ALL_HISTORY_POLICY as typeof ALL_HISTORY_POLICY,
									policySha256: sha256(ALL_HISTORY_POLICY_SPEC)
								}
							}
						: {}),
					environmentSha256: environmentBinding(input.environment),
					packageSha256: p.packageSha256,
					evidenceSha256,
					validatorPassed:
						[0, 1].every(
							(index) =>
								results('validator', index).length === 1 &&
								results('validator', index)[0].verdict === 'AC' &&
								(!production ||
									measured(
										results('validator', index)[0],
										true,
										index === 0 ? suiteCount : validatorExecutions[index].samples.length + 10
									))
						) &&
						refs.timeLimitExceeded.every(
							(_, i) =>
								results('slowSample', i).length === 1 &&
								results('slowSample', i)[0].verdict === 'AC' &&
								(!production || measured(results('slowSample', i)[0], true, p.samples.length))
						),
					accepted,
					timeLimitExceeded: refs.timeLimitExceeded.map((_, i) => ({
						slowestTestMs: results('timeLimitExceeded', i)
							.filter((r) => allHistory || r.verdict === 'AC' || r.verdict === 'TLE')
							.map((r) => r.slowestTestMs),
						...(allHistory
							? {
									passed: results('timeLimitExceeded', i).map(
										(r) =>
											(r.verdict === 'AC' || r.verdict === 'TLE') && measured(r, r.verdict === 'AC')
									)
								}
							: {})
					})),
					wrongAnswerFailed: refs.wrongAnswer.map(
						(_, i) =>
							results('wrongAnswer', i).length === 1 &&
							results('wrongAnswer', i)[0].verdict === 'WA' &&
							(!production || measured(results('wrongAnswer', i)[0], false))
					)
				};
				const outcome = yield* step(
					ctx.runMutation(
						production
							? internal.problems._activateProduction
							: allHistory
								? internal.problems._activateAllHistory
								: internal.problems._activate,
						{ problemVersionId: a.problemVersionId, calibration }
					)
				);
				return { ...outcome, evidenceSha256 };
			})
		);
}
export const _finalize = internalAction({
	args: { problemVersionId: v.id('problemVersions'), decisionPolicy: v.optional(decisionPolicy) },
	handler: finalize(false)
});
export const _finalizeProduction = internalAction({
	args: { problemVersionId: v.id('problemVersions') },
	handler: (ctx, a) => finalize(true)(ctx, { ...a, decisionPolicy: ALL_HISTORY_POLICY })
});

// Re-enterable operator/scheduler recovery. Failure leaves the durable slot held.
export const _cleanup = internalAction({
	args: { reservationId: v.id('auditLog'), retry: v.optional(v.number()) },
	handler: (ctx, a): Promise<void> =>
		runBackend(
			Effect.gen(function* () {
				const deployment = yield* deploymentConfig(true);
				const owner = yield* step(
					ctx.runQuery(internal.calibrationState._cleanupTarget, { reservationId: a.reservationId })
				);
				if (!owner) return;
				const { sandboxId } = owner;
				yield* withModalClient((client) =>
					Effect.gen(function* () {
						if (deployment.production) {
							const app = yield* calibrationTransport(() =>
								client.apps.fromName(deployment.appName)
							);
							if (!owner.appId || app.appId !== owner.appId)
								return yield* Effect.fail(new CalibrationFailure('CALIBRATION_APP_BINDING'));
						}
						const sb = yield* calibrationTransport(() => client.sandboxes.fromId(sandboxId));
						const tags = yield* calibrationTransport(() => sb.getTags());
						if (
							tags.app !== 'beatcode' ||
							tags.deployment !== deployment.deployment ||
							tags.attemptId !== String(a.reservationId) ||
							(deployment.production && tags.calibrationAppId !== owner.appId)
						)
							return yield* Effect.fail(new CalibrationFailure('CALIBRATION_OWNERSHIP'));
						yield* calibrationTransport(() => sb.terminate());
						const deadline = Date.now() + 2000;
						while ((yield* calibrationTransport(() => sb.poll())) === null) {
							if (Date.now() >= deadline)
								return yield* Effect.fail(new CalibrationFailure('CALIBRATION_CLEANUP_PENDING'));
							yield* Effect.sleep(100);
						}
						yield* step(
							ctx.runMutation(internal.calibrationState._terminated, {
								reservationId: a.reservationId,
								sandboxId
							})
						);
					})
				).pipe(
					Effect.catchCause(() =>
						Effect.gen(function* () {
							const retry = a.retry ?? 0;
							if (retry < 8)
								yield* step(
									ctx.scheduler.runAfter(1000 * 2 ** retry, internal.calibration._cleanup, {
										reservationId: a.reservationId,
										retry: retry + 1
									})
								);
						})
					)
				);
			})
		)
});

// Explicit operator recovery for a lost create response. An empty list never releases a slot.
export const _reconcile = internalAction({
	args: { reservationId: v.id('auditLog') },
	handler: (ctx, a): Promise<void> =>
		runBackend(
			Effect.gen(function* () {
				const deployment = yield* deploymentConfig(true);
				const status = yield* step(ctx.runQuery(internal.calibrationState._status, {}));
				const owner = status.jobs.find((j) => j.reservationId === a.reservationId);
				if (!owner || owner.released) return;
				if (owner.creation === 'known') {
					yield* step(ctx.runAction(internal.calibration._cleanup, a));
					return;
				}
				if (owner.creation !== 'creating' || owner.deadline > Date.now()) return;
				yield* withModalClient((client) =>
					Effect.gen(function* () {
						const app = yield* calibrationTransport(() =>
							client.apps.fromName(process.env.MODAL_APP_NAME!)
						);
						if (
							deployment.production &&
							(!owner.appId ||
								app.appId !== owner.appId ||
								owner.deployment !== deployment.deployment)
						)
							return yield* Effect.fail(new CalibrationFailure('CALIBRATION_APP_BINDING'));
						const iterator = client.sandboxes
							.list({
								appId: app.appId,
								tags: {
									app: 'beatcode',
									deployment: deployment.deployment,
									attemptId: String(a.reservationId)
								}
							})
							[Symbol.asyncIterator]();
						yield* Effect.acquireUseRelease(
							Effect.succeed(iterator),
							(iter) =>
								Effect.gen(function* () {
									for (let count = 0; count < 100; count++) {
										const next = yield* calibrationTransport(() => iter.next());
										if (next.done) break;
										const tags = yield* calibrationTransport(() => next.value.getTags());
										if (
											tags.app !== 'beatcode' ||
											tags.deployment !== deployment.deployment ||
											tags.attemptId !== String(a.reservationId) ||
											(deployment.production && tags.calibrationAppId !== owner.appId)
										)
											continue;
										yield* step(
											ctx.runMutation(internal.calibrationState._created, {
												...a,
												sandboxId: next.value.sandboxId
											})
										);
										yield* step(ctx.runAction(internal.calibration._cleanup, a));
										break;
									}
								}),
							(iter) => calibrationTransport(() => iter.return(undefined))
						);
					})
				);
			})
		)
});
