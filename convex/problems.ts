import { serializeReferences } from '../shared/calibrationDeployment';
import type { Infer } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { deploymentConfig } from './calibrationConfig';
import { serializeEnvironment } from '../shared/environment';
import { Effect } from 'effect';
import { runBackend, step, reject, syncStep } from './game/effect';
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { fail } from './game/access';
import {
	limits,
	samples,
	references,
	calibration,
	decisionPolicy,
	ALL_HISTORY_POLICY,
	ALL_HISTORY_POLICY_SPEC,
	productionBaseline,
	productionApp
} from './game/validators';
import { sha256 } from './game/binding';

const environmentFields = {
	envId: v.string(),
	modalImageId: v.string(),
	baseDigest: v.string(),
	gccVersion: v.string(),
	runtime: v.literal('gvisor'),
	cpu: v.literal(1),
	runnerSha256: v.string(),
	productionApp: v.optional(productionApp)
};
function hash(value: string) {
	if (!/^[a-f0-9]{64}$/.test(value)) fail('BAD_INPUT');
}
function text(value: string, max: number) {
	if (!value.trim() || new TextEncoder().encode(value).length > max) fail('BAD_INPUT');
}
export const _registerEnvironment = internalMutation({
	args: environmentFields,
	handler: (ctx, args) =>
		runBackend(
			Effect.gen(function* () {
				const deployment = yield* deploymentConfig();
				if (
					deployment.production !== !!args.productionApp ||
					(args.productionApp && !/^ap-[A-Za-z0-9]{22}$/.test(args.productionApp.appId))
				)
					return yield* reject('BAD_INPUT');
				yield* syncStep(() => hash(args.runnerSha256));
				if (!/^sha256:[a-f0-9]{64}$/.test(args.baseDigest)) return yield* reject('BAD_INPUT');
				for (const value of [args.envId, args.modalImageId, args.gccVersion])
					yield* syncStep(() => text(value, 100));
				const old = yield* step(
					ctx.db
						.query('judgeEnvironments')
						.withIndex('by_env', (q) => q.eq('envId', args.envId))
						.unique()
				);
				if (old) {
					if (
						Object.entries(args).some(
							([key, value]) =>
								JSON.stringify(old[key as keyof typeof args]) !== JSON.stringify(value)
						)
					)
						return yield* reject('BAD_INPUT', 'Environment identities are immutable');
					return { judgeEnvId: old._id };
				}
				return {
					judgeEnvId: yield* step(ctx.db.insert('judgeEnvironments', { ...args, status: 'active' }))
				};
			})
		)
});
export const _createVersion = internalMutation({
	args: {
		slug: v.string(),
		title: v.string(),
		difficulty: v.union(v.literal(1), v.literal(2), v.literal(3)),
		version: v.number(),
		statementMd: v.string(),
		samples,
		limits,
		testsStorageId: v.id('_storage'),
		testsSha256: v.string(),
		packageSha256: v.string(),
		judgeEnvId: v.id('judgeEnvironments'),
		referenceSolutions: references,
		productionBaseline: v.optional(productionBaseline)
	},
	handler: (ctx, args) =>
		runBackend(
			Effect.gen(function* () {
				if (
					!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.slug) ||
					args.slug.length > 80 ||
					!Number.isSafeInteger(args.version) ||
					args.version < 1
				)
					return yield* reject('BAD_INPUT');
				yield* syncStep(() => text(args.title, 200));
				yield* syncStep(() => text(args.statementMd, 65536));
				yield* syncStep(() => hash(args.testsSha256));
				yield* syncStep(() => hash(args.packageSha256));
				const l = args.limits;
				if (
					![256, 512].includes(l.memoryMiB) ||
					!Number.isInteger(l.outputKiB) ||
					l.outputKiB < 1 ||
					l.outputKiB > 1024 ||
					!Number.isInteger(l.aggregateMs) ||
					l.aggregateMs < 1 ||
					l.aggregateMs > 15000 ||
					!Number.isInteger(l.timeMs) ||
					l.timeMs < 500 ||
					l.timeMs > 3000
				)
					return yield* reject('BAD_INPUT');
				if (
					args.samples.length < 1 ||
					args.samples.length > 3 ||
					args.samples.some(
						(s) =>
							new TextEncoder().encode(s.input).length > 4096 ||
							new TextEncoder().encode(s.output).length > 4096
					)
				)
					return yield* reject('BAD_INPUT');
				const sources = [
					...args.referenceSolutions.accepted,
					...args.referenceSolutions.timeLimitExceeded,
					...args.referenceSolutions.wrongAnswer,
					args.referenceSolutions.validator
				];
				if (
					!args.referenceSolutions.accepted.length ||
					!args.referenceSolutions.timeLimitExceeded.length ||
					!args.referenceSolutions.wrongAnswer.length ||
					sources.reduce((n, s) => n + new TextEncoder().encode(s).length, 0) > 400000
				)
					return yield* reject('BAD_INPUT');
				for (const source of sources) yield* syncStep(() => text(source, 65536));
				const env = yield* step(ctx.db.get(args.judgeEnvId)),
					blob = yield* step(ctx.db.system.get(args.testsStorageId));
				if (!env || env.status !== 'active' || !blob || blob.size > 32 * 1024 * 1024)
					return yield* reject('BAD_INPUT');
				const deployment = yield* deploymentConfig();
				const baseline = args.productionBaseline;
				if (deployment.production) {
					if (!baseline || !env.productionApp)
						return yield* reject('BAD_INPUT', 'PRODUCTION_BASELINE_REQUIRED');
					for (const value of [
						baseline.packageSha256,
						baseline.testsSha256,
						baseline.referencesSha256,
						baseline.evidenceSha256
					])
						yield* syncStep(() => hash(value));
					if (
						baseline.originPolicy === ALL_HISTORY_POLICY &&
						baseline.decisionPolicySha256 !== (yield* sha256(ALL_HISTORY_POLICY_SPEC))
					)
						return yield* reject('BAD_INPUT', 'PRODUCTION_BASELINE_POLICY');
					if (
						!baseline.originVersionId.trim() ||
						baseline.originVersion !== args.version ||
						!Number.isInteger(baseline.publicTimeMs) ||
						baseline.publicTimeMs < 500 ||
						baseline.publicTimeMs > 3000 ||
						baseline.publicTimeMs % 100 !== 0 ||
						baseline.packageSha256 !== args.packageSha256 ||
						baseline.testsSha256 !== args.testsSha256 ||
						baseline.referencesSha256 !==
							(yield* sha256(serializeReferences(args.referenceSolutions)))
					)
						return yield* reject('BAD_INPUT', 'PRODUCTION_BASELINE_MISMATCH');
				} else if (baseline) return yield* reject('BAD_INPUT');
				let problem = yield* step(
					ctx.db
						.query('problems')
						.withIndex('by_slug', (q) => q.eq('slug', args.slug))
						.unique()
				);
				if (!problem) {
					const id = yield* step(
						ctx.db.insert('problems', {
							slug: args.slug,
							title: args.title,
							difficulty: args.difficulty,
							retired: false
						})
					);
					problem = (yield* step(ctx.db.get(id)))!;
				} else if (problem.difficulty !== args.difficulty || problem.title !== args.title)
					return yield* reject('BAD_INPUT');
				const existing = yield* step(
					ctx.db
						.query('problemVersions')
						.withIndex('by_problem_version', (q) =>
							q.eq('problemId', problem._id).eq('version', args.version)
						)
						.unique()
				);
				if (existing) {
					if (
						existing.packageSha256 !== args.packageSha256 ||
						existing.judgeEnvId !== args.judgeEnvId ||
						existing.testsSha256 !== args.testsSha256 ||
						existing.statementMd !== args.statementMd ||
						existing.samples.length !== args.samples.length ||
						existing.samples.some(
							(sample, i) =>
								sample.input !== args.samples[i].input || sample.output !== args.samples[i].output
						) ||
						!existing.referenceSolutions ||
						serializeReferences(existing.referenceSolutions) !==
							serializeReferences(args.referenceSolutions) ||
						existing.limits.memoryMiB !== args.limits.memoryMiB ||
						existing.limits.outputKiB !== args.limits.outputKiB ||
						existing.limits.aggregateMs !== args.limits.aggregateMs ||
						(existing.status === 'draft' && existing.limits.timeMs !== args.limits.timeMs) ||
						JSON.stringify(existing.productionBaseline) !== JSON.stringify(args.productionBaseline)
					)
						return yield* reject('BAD_INPUT');
					return { problemVersionId: existing._id };
				}
				const { slug: _slug, title: _title, difficulty: _difficulty, ...version } = args;
				void _slug;
				void _title;
				void _difficulty;
				return {
					problemVersionId: yield* step(
						ctx.db.insert('problemVersions', {
							...version,
							problemId: problem._id,
							status: 'draft'
						})
					)
				};
			})
		)
});
export const _calibrationInput = internalQuery({
	args: { problemVersionId: v.id('problemVersions'), decisionPolicy: v.optional(decisionPolicy) },
	handler: (ctx, { problemVersionId, decisionPolicy }) =>
		runBackend(
			Effect.gen(function* () {
				const version = yield* step(ctx.db.get(problemVersionId));
				if (
					!version ||
					!['draft', 'calibrating', ...(decisionPolicy ? ['rejected'] : [])].includes(
						version.status
					)
				)
					return null;
				return { version, environment: yield* step(ctx.db.get(version.judgeEnvId)) };
			})
		)
});
// This consumes measurements from the trusted Modal calibrator. It never runs
// reference/contestant code, and a publish alone cannot activate a problem.
export const _activate = internalMutation({
	args: { problemVersionId: v.id('problemVersions'), calibration },
	handler: (ctx, args) =>
		runBackend(
			Effect.gen(function* () {
				if ((yield* deploymentConfig()).production)
					return yield* reject('BAD_STATE', 'PRODUCTION_PHASE6_REQUIRED');
				const p = yield* step(ctx.db.get(args.problemVersionId));
				if (!p || !p.referenceSolutions || !['draft', 'calibrating'].includes(p.status))
					return yield* reject('BAD_STATE');
				const env = yield* step(ctx.db.get(p.judgeEnvId));
				if (!env || env.status !== 'active') return yield* reject('BAD_STATE');
				const c = args.calibration;
				if (c.decisionPolicy) return yield* reject('BAD_INPUT');
				yield* syncStep(() => hash(c.evidenceSha256));
				yield* syncStep(() => hash(c.environmentSha256));
				yield* syncStep(() => hash(c.packageSha256));
				const fingerprint = yield* sha256(serializeEnvironment(env));
				if (c.environmentSha256 !== fingerprint || c.packageSha256 !== p.packageSha256)
					return yield* reject('BAD_INPUT');
				const repeats = (a: number[]) =>
					a.length === 8 && a.every((n) => Number.isFinite(n) && n > 0);
				const ac = c.accepted.flatMap((a) => a.slowestTestMs),
					tle = c.timeLimitExceeded.flatMap((a) => a.slowestTestMs);
				const timeMs = Math.ceil(Math.max(500, 2.5 * Math.max(...ac)) / 100) * 100;
				const valid =
					c.validatorPassed &&
					c.accepted.length === p.referenceSolutions.accepted.length &&
					c.timeLimitExceeded.length === p.referenceSolutions.timeLimitExceeded.length &&
					c.wrongAnswerFailed.length === p.referenceSolutions.wrongAnswer.length &&
					c.wrongAnswerFailed.every(Boolean) &&
					c.accepted.every(
						(a) =>
							a.passed.length === 8 &&
							a.passed.every(Boolean) &&
							repeats(a.slowestTestMs) &&
							repeats(a.aggregateMs) &&
							repeats(a.attemptWallMs) &&
							Math.max(...a.slowestTestMs) / Math.min(...a.slowestTestMs) <= 2 &&
							a.aggregateMs.every((n) => n <= 7500) &&
							a.attemptWallMs.every((n) => n <= 15000)
					) &&
					c.timeLimitExceeded.every((a) => repeats(a.slowestTestMs)) &&
					timeMs <= 3000 &&
					Math.min(...tle) >= 2.5 * timeMs;
				yield* step(
					ctx.db.patch(p._id, {
						status: valid ? 'active' : 'rejected',
						calibration: c,
						...(valid ? { limits: { ...p.limits, timeMs } } : {})
					})
				);
				if (valid) yield* step(ctx.db.patch(p.problemId, { activeVersionId: p._id }));
				return { activated: valid };
			})
		)
});
// Explicit retrospective decision, separate from ordinary legacy activation.
function activateAllHistory(production: boolean) {
	return (
		ctx: MutationCtx,
		args: {
			problemVersionId: Id<'problemVersions'>;
			calibration: Infer<typeof calibration>;
		}
	) =>
		runBackend(
			Effect.gen(function* () {
				const deployment = yield* deploymentConfig();
				if (deployment.production !== production)
					return yield* reject('BAD_STATE', 'PRODUCTION_PHASE6_REQUIRED');
				const p = yield* step(ctx.db.get(args.problemVersionId));
				if (!p?.referenceSolutions || !['draft', 'calibrating', 'rejected'].includes(p.status))
					return yield* reject('BAD_STATE');
				if (production && !p.productionBaseline)
					return yield* reject('BAD_INPUT', 'PRODUCTION_BASELINE_REQUIRED');
				const env = yield* step(ctx.db.get(p.judgeEnvId));
				if (!env || env.status !== 'active') return yield* reject('BAD_STATE');
				const c = args.calibration;
				const policySha256 = yield* sha256(ALL_HISTORY_POLICY_SPEC);
				if (
					c.decisionPolicy?.name !== ALL_HISTORY_POLICY ||
					c.decisionPolicy.policySha256 !== policySha256
				)
					return yield* reject('BAD_INPUT');
				for (const value of [c.evidenceSha256, c.environmentSha256, c.packageSha256])
					yield* syncStep(() => hash(value));
				if (
					c.environmentSha256 !== (yield* sha256(serializeEnvironment(env))) ||
					c.packageSha256 !== p.packageSha256
				)
					return yield* reject('BAD_INPUT');
				const repeats = (a: number[]) =>
					a.length >= 8 && a.every((n) => Number.isFinite(n) && n > 0);
				const ac = c.accepted.flatMap((a) => a.slowestTestMs);
				const slow = c.timeLimitExceeded.flatMap((a) => a.slowestTestMs);
				const timeMs = Math.ceil(Math.max(500, 2.5 * Math.max(...ac)) / 100) * 100;
				const adr3Valid =
					c.validatorPassed &&
					c.accepted.length === p.referenceSolutions.accepted.length &&
					c.timeLimitExceeded.length === p.referenceSolutions.timeLimitExceeded.length &&
					c.wrongAnswerFailed.length === p.referenceSolutions.wrongAnswer.length &&
					c.wrongAnswerFailed.every(Boolean) &&
					c.accepted.every(
						(a) =>
							repeats(a.slowestTestMs) &&
							a.passed.length === a.slowestTestMs.length &&
							a.passed.every(Boolean) &&
							a.aggregateMs.length === a.passed.length &&
							a.attemptWallMs.length === a.passed.length &&
							repeats(a.aggregateMs) &&
							repeats(a.attemptWallMs) &&
							a.slowestTestMs.every((n) => n <= 7500) &&
							a.aggregateMs.every((n) => n <= 7500) &&
							a.attemptWallMs.every((n) => n <= 15000)
					) &&
					c.timeLimitExceeded.every(
						(a) =>
							repeats(a.slowestTestMs) &&
							a.passed?.length === a.slowestTestMs.length &&
							a.passed.every(Boolean)
					) &&
					timeMs <= 3000 &&
					Math.min(...slow) >= 2.5 * timeMs;
				const baseline = p.productionBaseline;
				const outcome = !adr3Valid
					? ('ADR3_FAILED' as const)
					: production && Math.max(...ac) > baseline!.publicTimeMs / 2
						? ('PHASE6_AC_MARGIN' as const)
						: production && Math.min(...slow) < 2 * baseline!.publicTimeMs
							? ('PHASE6_SLOW_MARGIN' as const)
							: ('PASSED' as const);
				const valid = outcome === 'PASSED';
				const productionDecision = production
					? {
							name: 'production-phase6-all-history-v1' as const,
							outcome,
							baselineSha256: yield* sha256(JSON.stringify(baseline)),
							evidenceSha256: c.evidenceSha256,
							selectedTimeMs: timeMs
						}
					: undefined;
				const stats = (values: number[]) => ({
					count: values.length,
					min: values.length ? Math.min(...values) : null,
					max: values.length ? Math.max(...values) : null,
					spread: values.length ? Math.max(...values) / Math.min(...values) : null
				});
				yield* step(
					ctx.db.insert('auditLog', {
						at: Date.now(),
						kind: production
							? 'calibration-decision-production-phase6-all-history-v1'
							: 'calibration-decision-alpha-complexity-all-history-v1',
						refId: p._id,
						detail: JSON.stringify({
							...(production ? { productionDecision, productionBaseline: baseline } : {}),
							decisionPolicy: c.decisionPolicy,
							evidenceSha256: c.evidenceSha256,
							priorStatus: p.status,
							priorCalibration: p.calibration ?? null,
							// Diagnostic computation only: no claim that a legacy decision was made.
							allHistorySpreadDiagnostic: c.accepted.every(
								(a) => Math.max(...a.slowestTestMs) / Math.min(...a.slowestTestMs) <= 2
							)
								? 'PASSED'
								: 'FAILED',
							activated: valid,
							timeMs,
							calibration: c,
							accepted: c.accepted.map((a) => ({
								...stats(a.slowestTestMs),
								passedCount: a.passed.filter(Boolean).length,
								maxAggregateMs: Math.max(...a.aggregateMs),
								maxAttemptWallMs: Math.max(...a.attemptWallMs)
							})),
							slow: c.timeLimitExceeded.map((a) => ({
								...stats(a.slowestTestMs),
								genuineCount: a.passed?.filter(Boolean).length ?? 0
							})),
							publicHeadroomMs: timeMs - Math.max(...ac),
							slowMarginMs: Math.min(...slow) - 2.5 * timeMs
						})
					})
				);
				yield* step(
					ctx.db.patch(p._id, {
						status: valid ? 'active' : 'rejected',
						calibration: c,
						...(productionDecision ? { productionDecision } : {}),
						...(valid ? { limits: { ...p.limits, timeMs } } : {})
					})
				);
				if (valid) yield* step(ctx.db.patch(p.problemId, { activeVersionId: p._id }));
				return { activated: valid, ...(productionDecision ? { productionDecision } : {}) };
			})
		);
}
export const _activateAllHistory = internalMutation({
	args: { problemVersionId: v.id('problemVersions'), calibration },
	handler: activateAllHistory(false)
});
export const _activateProduction = internalMutation({
	args: { problemVersionId: v.id('problemVersions'), calibration },
	handler: activateAllHistory(true)
});
// CLI-only upload capability: never returned by a public function.
export const _uploadUrl = internalMutation({
	args: {},
	handler: (ctx) =>
		runBackend(
			Effect.gen(function* () {
				return { uploadUrl: yield* step(ctx.storage.generateUploadUrl()) };
			})
		)
});
