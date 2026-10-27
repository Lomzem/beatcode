import { mkdirSync, writeFileSync } from 'node:fs';
import { Effect } from 'effect';
import { EXECUTION_POLICY } from '../../shared/calibrationDeployment.ts';
import { devCall } from './operator.ts';
import { OperatorError, operatorSync } from './effects.ts';

interface Job {
	reservationId: string;
	retryOf?: string;
	retryApproval?: 'reviewed-empty-error-once';
	creation?: string;
	released: boolean;
	executionPolicy?: string;
	problemVersionId: string;
	role: string;
	index: number;
	repeat: number;
	result?: {
		verdict: string;
		slowestTestMs: number;
		aggregateMs: number;
		attemptWallMs: number;
		testWallMs: number[];
		execObservedMs: number[];
	};
}

const calibrate = Effect.gen(function* () {
	const problemVersionId = process.argv[2];
	if (!problemVersionId) return yield* new OperatorError({ message: 'VERSION_REQUIRED' });
	const policyFlag = process.argv.indexOf('--decision-policy');
	const decisionPolicy = policyFlag < 0 ? undefined : process.argv[policyFlag + 1];
	if (policyFlag >= 0 && decisionPolicy !== 'alpha-complexity-all-history-v1')
		return yield* new OperatorError({ message: 'UNKNOWN_DECISION_POLICY' });
	if (decisionPolicy && process.argv.includes('--accepted-retry-only'))
		return yield* new OperatorError({ message: 'ALL_HISTORY_HAS_NO_SPREAD_RETRY' });
	const selection = decisionPolicy ? { decisionPolicy } : {};
	const root = '.scratch/competitive-leetcode/calibration';
	yield* operatorSync('CALIBRATION_EVIDENCE_WRITE_FAILED', () =>
		mkdirSync(root, { recursive: true, mode: 0o700 })
	);
	const status = () =>
		Effect.gen(function* () {
			const receipt = yield* devCall<{ executionPolicy?: string; jobs: Job[] }>(
				'calibrationState:_status',
				{}
			);
			if (
				receipt.executionPolicy !== EXECUTION_POLICY ||
				receipt.jobs.some(
					(j) => j.problemVersionId === problemVersionId && j.executionPolicy !== EXECUTION_POLICY
				)
			)
				return yield* new OperatorError({ message: 'CALIBRATION_POLICY_REQUIRES_FRESH_VERSION' });
			return receipt;
		});
	// Check before any action, including resume of already completed jobs.
	const initial = yield* status();
	const retryFlag = process.argv.indexOf('--retry-error');
	if (retryFlag >= 0) {
		if (!process.argv.includes('--approve-empty-error-once'))
			return yield* new OperatorError({ message: 'EXPLICIT_REJUDGE_APPROVAL_REQUIRED' });
		const primary = initial.jobs.find((j) => j.reservationId === process.argv[retryFlag + 1]);
		if (!primary || primary.problemVersionId !== problemVersionId || primary.retryOf)
			return yield* new OperatorError({ message: 'EXACT_PRIMARY_RESERVATION_REQUIRED' });
		const result = yield* devCall('calibration:_job', {
			problemVersionId,
			role: primary.role,
			index: primary.index,
			repeat: primary.repeat,
			retryOf: primary.reservationId,
			retryApproval: 'reviewed-empty-error-once',
			...selection
		});
		const receipt = yield* status();
		yield* operatorSync('CALIBRATION_EVIDENCE_WRITE_FAILED', () =>
			writeFileSync(`${root}/${problemVersionId}.json`, JSON.stringify(receipt, null, 2), {
				mode: 0o600
			})
		);
		console.log(JSON.stringify({ retryOf: primary.reservationId, result }));
		return;
	}
	if (process.argv.includes('--approve-empty-error-once'))
		return yield* new OperatorError({ message: 'EXACT_PRIMARY_RESERVATION_REQUIRED' });
	const input = yield* devCall<{
		version: {
			referenceSolutions: {
				accepted: string[];
				timeLimitExceeded: string[];
				wrongAnswer: string[];
			};
		};
	}>('problems:_calibrationInput', { problemVersionId, ...selection });
	const refs = input.version.referenceSolutions;
	function run(role: string, index: number, repeat: number) {
		return Effect.gen(function* () {
			const job = { problemVersionId, role, index, repeat, ...selection };
			const jobs = (yield* status()).jobs;
			const primary = jobs.find(
				(j) =>
					j.problemVersionId === problemVersionId &&
					j.role === role &&
					j.index === index &&
					j.repeat === repeat &&
					!j.retryOf
			);
			const prior =
				jobs.find(
					(j) =>
						j.retryOf === primary?.reservationId && j.retryApproval === 'reviewed-empty-error-once'
				) ?? primary;
			if (prior && (!prior.result || !prior.released))
				return yield* new OperatorError({ message: 'INTERRUPTED_JOB_REQUIRES_REVIEW' });
			const result =
				prior?.result ?? (yield* devCall<NonNullable<Job['result']>>('calibration:_job', job));
			const receipt = yield* status();
			yield* operatorSync('CALIBRATION_EVIDENCE_WRITE_FAILED', () =>
				writeFileSync(`${root}/${problemVersionId}.json`, JSON.stringify(receipt, null, 2), {
					mode: 0o600
				})
			);
			console.log(JSON.stringify({ ...job, result }));
			if (result.verdict === 'ERROR')
				return yield* new OperatorError({ message: 'EMPTY_ERROR_REQUIRES_EXPLICIT_REVIEW' });
			if (['validator', 'slowSample', 'accepted'].includes(role) && result.verdict !== 'AC')
				return yield* new OperatorError({ message: 'REFERENCE_FAILED_STOPPED' });
			return result;
		});
	}
	if (process.argv.includes('--accepted-retry-only')) {
		for (let i = 0; i < refs.accepted.length; i++)
			for (let r = 8; r < 16; r++) yield* run('accepted', i, r);
	} else {
		yield* run('validator', 0, 0);
		yield* run('validator', 1, 0);
		for (let i = 0; i < refs.timeLimitExceeded.length; i++) yield* run('slowSample', i, 0);
		for (let i = 0; i < refs.accepted.length; i++) {
			if (decisionPolicy) {
				const physical = (yield* status()).jobs.filter(
					(j) => j.problemVersionId === problemVersionId
				);
				const observed = physical
					.filter((j) => !j.retryOf && j.role === 'accepted' && j.index === i)
					.map(
						(j) =>
							physical.find(
								(r) =>
									r.retryOf === j.reservationId && r.retryApproval === 'reviewed-empty-error-once'
							) ?? j
					);
				if (
					observed.some(
						(j) =>
							!j.released ||
							!j.result ||
							j.result.verdict !== 'AC' ||
							!j.result.testWallMs?.length ||
							j.result.testWallMs.length !== j.result.execObservedMs?.length ||
							[...j.result.testWallMs, ...j.result.execObservedMs, j.result.attemptWallMs].some(
								(n) => !Number.isFinite(n) || n <= 0
							) ||
							j.result.slowestTestMs !== Math.max(...j.result.testWallMs) ||
							j.result.aggregateMs !== j.result.testWallMs.reduce((sum, n) => sum + n, 0) ||
							j.result.slowestTestMs > 1200 ||
							j.result.aggregateMs > 7500 ||
							j.result.attemptWallMs > 15000
					)
				)
					return yield* new OperatorError({ message: 'ALL_HISTORY_ACCEPTED_EVIDENCE_FAILED' });
				let count = observed.length;
				for (let r = 0; r < 8 && count < 8; r++) {
					if (physical.some((j) => j.role === 'accepted' && j.index === i && j.repeat === r))
						continue;
					const result = yield* run('accepted', i, r);
					if (
						result.slowestTestMs > 1200 ||
						result.aggregateMs > 7500 ||
						result.attemptWallMs > 15000
					)
						return yield* new OperatorError({ message: 'AC_LIMIT_FAILED_STOPPED' });
					count++;
				}
				if (count < 8)
					return yield* new OperatorError({ message: 'ALL_HISTORY_ACCEPTED_EVIDENCE_FAILED' });
				continue;
			}
			let measured: NonNullable<Job['result']>[] = [];
			for (let r = 0; r < 8; r++) measured.push(yield* run('accepted', i, r));
			if (measured.some((r) => r.aggregateMs > 7500 || r.attemptWallMs > 15000))
				return yield* new OperatorError({ message: 'AC_LIMIT_FAILED_STOPPED' });
			const spread = () =>
				Math.max(...measured.map((r) => r.slowestTestMs)) /
				Math.min(...measured.map((r) => r.slowestTestMs));
			if (spread() > 2) {
				measured = [];
				for (let r = 8; r < 16; r++) measured.push(yield* run('accepted', i, r));
			}
			if (spread() > 2 || measured.some((r) => r.aggregateMs > 7500 || r.attemptWallMs > 15000))
				return yield* new OperatorError({ message: 'AC_RETRY_FAILED_STOPPED' });
		}
		for (let i = 0; i < refs.timeLimitExceeded.length; i++)
			for (let r = 0; r < 8; r++) yield* run('timeLimitExceeded', i, r);
		for (let i = 0; i < refs.wrongAnswer.length; i++) yield* run('wrongAnswer', i, 0);
		console.log(
			JSON.stringify(yield* devCall('calibration:_finalize', { problemVersionId, ...selection }))
		);
	}
});

await Effect.runPromise(calibrate);
