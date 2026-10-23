import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { devRun } from '../../scripts/problems/operator';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: vi.fn(), mkdirSync: vi.fn(), writeFileSync: vi.fn() }));

beforeEach(() => {
	vi.mocked(readFileSync).mockReturnValue('CONVEX_DEPLOYMENT=dev:descriptive-scorpion-877\n');
	vi.mocked(execFileSync).mockReturnValue('');
});

describe('DEV operator CLI boundary', () => {
	it('acknowledges a successful void mutation without parsing absent output', () => {
		expect(devRun('calibrationState:_finish', { reservationId: 'reservation' })).toBeUndefined();
	});
	it('decodes returned JSON and preserves an explicit null', () => {
		vi.mocked(execFileSync).mockReturnValueOnce('{"released":true}').mockReturnValueOnce('null');
		expect(devRun('calibration:status', {})).toEqual({ released: true });
		expect(devRun('calibration:status', {})).toBeNull();
	});
	it('blocks the wrong deployment before invoking the CLI', () => {
		vi.mocked(readFileSync).mockReturnValue('CONVEX_DEPLOYMENT=prod:careful-greyhound-596');
		const before = vi.mocked(execFileSync).mock.calls.length;
		expect(() => devRun('calibration:status', {})).toThrow('DEV_DEPLOYMENT_REQUIRED');
		expect(execFileSync).toHaveBeenCalledTimes(before);
	});
	it('sanitizes process and decode failures without retaining payloads', () => {
		vi.mocked(execFileSync).mockImplementationOnce(() => {
			throw new Error('secret-reference-source-and-token');
		});
		expect(() => devRun('calibration:status', {})).toThrow(
			'DEV_OPERATOR_CALL_FAILED:calibration:status'
		);
		vi.mocked(execFileSync).mockReturnValueOnce('private-malformed-payload');
		expect(() => devRun('calibration:status', {})).toThrow(
			'DEV_OPERATOR_OUTPUT_INVALID:calibration:status'
		);
	});
});

it.each([false, true])(
	'the operator rejudges only the exact selected receipt with explicit approval=%s',
	async (approved) => {
		vi.resetModules();
		const argv = process.argv;
		const output = vi.spyOn(console, 'log').mockImplementation(() => {});
		const dispatched: { name: string; args: unknown }[] = [];
		vi.mocked(execFileSync).mockImplementation((_file, argv) => {
			const name = String(argv![6]);
			const args = JSON.parse(String(argv![7]));
			dispatched.push({ name, args });
			if (name === 'calibrationState:_status')
				return JSON.stringify({
					executionPolicy: 'staged-input-reference-10s-v1',
					jobs: [
						{
							reservationId: 'selected-primary',
							problemVersionId: 'version',
							role: 'timeLimitExceeded',
							index: 0,
							repeat: 7,
							executionPolicy: 'staged-input-reference-10s-v1',
							released: true
						}
					]
				});
			if (name === 'calibration:_job') return JSON.stringify({ verdict: 'TLE' });
			throw new Error('Unexpected operator dispatch');
		});
		try {
			process.argv = [
				'node',
				'calibrate.ts',
				'version',
				'--retry-error',
				'selected-primary',
				...(approved ? ['--approve-empty-error-once'] : [])
			];
			const running = import('../../scripts/problems/calibrate');
			if (approved) await running;
			else await expect(running).rejects.toThrow('EXPLICIT_REJUDGE_APPROVAL_REQUIRED');
			expect(dispatched.filter((call) => call.name !== 'calibrationState:_status')).toEqual(
				approved
					? [
							{
								name: 'calibration:_job',
								args: {
									problemVersionId: 'version',
									role: 'timeLimitExceeded',
									index: 0,
									repeat: 7,
									retryOf: 'selected-primary',
									retryApproval: 'reviewed-empty-error-once'
								}
							}
						]
					: []
			);
		} finally {
			process.argv = argv;
			output.mockRestore();
		}
	}
);

it.each([false, true])(
	'resumes named all-history partial history without extra accepted dispatch; old failure=%s',
	async (oldFailure) => {
		vi.resetModules();
		const argv = process.argv;
		const output = vi.spyOn(console, 'log').mockImplementation(() => {});
		const dispatched: { name: string; args: Record<string, unknown> }[] = [];
		const jobs = [
			...Array.from({ length: 15 }, (_, repeat) => ({
				role: 'accepted',
				index: 0,
				repeat,
				wall: repeat === 7 ? 268 : 69
			})),
			{ role: 'validator', index: 0, repeat: 0, wall: 1 },
			{ role: 'validator', index: 1, repeat: 0, wall: 1 },
			{ role: 'slowSample', index: 0, repeat: 0, wall: 1 }
		].map((j, i) => ({
			...j,
			reservationId: `receipt-${i}`,
			problemVersionId: 'version',
			executionPolicy: 'staged-input-reference-10s-v1',
			released: true,
			result: {
				verdict: oldFailure && i === 0 ? 'WA' : 'AC',
				slowestTestMs: j.wall,
				aggregateMs: j.wall,
				attemptWallMs: 1000,
				testWallMs: [j.wall],
				execObservedMs: [j.wall]
			}
		}));
		vi.mocked(execFileSync).mockImplementation((_file, argv) => {
			const name = String(argv![6]);
			const args = JSON.parse(String(argv![7]));
			dispatched.push({ name, args });
			if (name === 'calibrationState:_status')
				return JSON.stringify({ executionPolicy: 'staged-input-reference-10s-v1', jobs });
			if (name === 'problems:_calibrationInput')
				return JSON.stringify({
					version: {
						referenceSolutions: {
							accepted: ['fixture'],
							timeLimitExceeded: ['fixture'],
							wrongAnswer: ['fixture']
						}
					}
				});
			if (name === 'calibration:_job')
				return JSON.stringify({
					verdict: args.role === 'wrongAnswer' ? 'WA' : args.role === 'accepted' ? 'AC' : 'TLE',
					slowestTestMs: 69,
					aggregateMs: 69,
					attemptWallMs: 1000
				});
			if (name === 'calibration:_finalize') return JSON.stringify({ activated: true });
			throw new Error('Unexpected dispatch');
		});
		try {
			process.argv = [
				'node',
				'calibrate.ts',
				'version',
				'--decision-policy',
				'alpha-complexity-all-history-v1'
			];
			const running = import('../../scripts/problems/calibrate');
			if (oldFailure) {
				await expect(running).rejects.toThrow('ALL_HISTORY_ACCEPTED_EVIDENCE_FAILED');
				expect(dispatched.filter((c) => c.name === 'calibration:_job')).toEqual([]);
				return;
			}
			await running;
			expect(
				dispatched.filter((c) => c.name === 'calibration:_job').map((c) => c.args.role)
			).toEqual([
				'timeLimitExceeded',
				'timeLimitExceeded',
				'timeLimitExceeded',
				'timeLimitExceeded',
				'timeLimitExceeded',
				'timeLimitExceeded',
				'timeLimitExceeded',
				'timeLimitExceeded',
				'wrongAnswer'
			]);
			expect(dispatched.at(-1)).toEqual({
				name: 'calibration:_finalize',
				args: { problemVersionId: 'version', decisionPolicy: 'alpha-complexity-all-history-v1' }
			});
		} finally {
			process.argv = argv;
			output.mockRestore();
		}
	}
);
