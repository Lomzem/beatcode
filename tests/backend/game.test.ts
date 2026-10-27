import { convexTest } from 'convex-test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FunctionArgs } from 'convex/server';
import { present, lobby, seedProblems, deck, start } from './game.fixture';
import schema from '../../convex/schema';
import { api, internal } from '../../convex/_generated/api';
const modules = {
	...import.meta.glob('../../convex/**/*.ts'),
	'../../convex/judgeController.ts': () => import('./trustedJudge.fixture')
};
const harness = () => convexTest(schema, modules);
async function claimAll(t: ReturnType<typeof harness>) {
	const jobs = await t.mutation(internal.judge._pump, {});
	return Promise.all(
		jobs.map(async (job) => ({
			...job,
			claim: await t.mutation(internal.judge._claim, job)
		}))
	);
}
const result = (
	verdict: FunctionArgs<typeof internal.judge._complete>['result']['verdict']
): FunctionArgs<typeof internal.judge._complete>['result'] => ({
	verdict,
	phase: 'hidden',
	sandboxSeconds: 2,
	actionSeconds: 3
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});
describe('authenticated game API', () => {
	it('fails closed for legacy active production versions without a Phase 6 baseline', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { a, b, roomId } = await lobby(t);
		await seedProblems(t);
		vi.stubEnv('CONVEX_CLOUD_URL', 'https://careful-greyhound-596.convex.cloud');
		vi.stubEnv('CONVEX_DEPLOYMENT', 'prod:careful-greyhound-596');
		for (const client of [a, b]) await client.mutation(api.decks.set, { roomId, cardIds: deck });
		await a.mutation(api.rooms.setReady, { roomId, ready: true });
		await expect(b.mutation(api.rooms.setReady, { roomId, ready: true })).rejects.toThrow(
			'Active calibrated problem pool is incomplete'
		);
	});

	it('accepts all 53 permitted test measurements while rejecting oversized judge completion', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { a, matchId, roundId } = await start(t);
		await t.mutation(internal.ops.setJudging, { enabled: true });
		const submitted = await a.mutation(api.submissions.submit, {
			roundId,
			source: 'trusted result fixture',
			clientSubmitId: 'maximum-metrics'
		});
		const [job] = await claimAll(t);
		const completion = (count: number) => ({
			attemptId: job.attemptId,
			leaseVersion: job.leaseVersion,
			result: {
				...result('AC'),
				metrics: {
					testWallMs: Array<number>(count).fill(10),
					execObservedMs: Array<number>(count).fill(15)
				}
			}
		});
		await expect(t.mutation(internal.judge._complete, completion(54))).rejects.toThrow('BAD_INPUT');
		await t.mutation(internal.judge._complete, completion(53));
		const view = await a.query(api.matches.view, { matchId });
		expect(view.rounds[0]).toMatchObject({
			outcome: 'won',
			winnerId: view.playerId,
			winningSubmissionId: submitted.submissionId
		});
	});
	it('keeps historical membership and source consent with the original players after guest replacement', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { a, b, roomId, matchId, roundId } = await start(t);
		await t.mutation(internal.ops.setJudging, { enabled: true });
		await b.mutation(api.submissions.submit, {
			roundId,
			source: 'original guest private source',
			clientSubmitId: 'guest-history'
		});
		await a.mutation(api.matches.concede, { matchId });
		await b.mutation(api.rooms.leave, { roomId });
		const c = t.withIdentity({ tokenIdentifier: 'issuer|replacement' });
		await c.mutation(api.players.ensure, { displayName: 'Replacement' });
		const invite = await a.mutation(api.rooms.regenerateInvite, { roomId });
		await c.mutation(api.rooms.join, { roomId, ...invite });
		await expect(c.query(api.matches.view, { matchId })).rejects.toThrow('NOT_FOUND');
		await expect(c.mutation(api.matches.shareSource, { matchId })).rejects.toThrow('NOT_FOUND');
		await expect(c.mutation(api.matches.concede, { matchId })).rejects.toThrow('NOT_FOUND');
		await expect(c.mutation(api.matches.claimForfeit, { matchId })).rejects.toThrow('NOT_FOUND');
		await expect(c.mutation(api.rounds.readyNext, { roundId })).rejects.toThrow('NOT_FOUND');
		await expect(
			c.mutation(api.submissions.submit, { roundId, source: 'x', clientSubmitId: 'outsider' })
		).rejects.toThrow('NOT_FOUND');
		await expect(
			c.mutation(api.samples.run, { roundId, source: 'x', clientRunId: 'outsider' })
		).rejects.toThrow('NOT_FOUND');
		expect((await a.query(api.matches.view, { matchId })).rounds[0].sharedSource).toBeNull();
		expect((await b.query(api.matches.view, { matchId })).rounds[0].ownSubmissions[0].source).toBe(
			'original guest private source'
		);
		await b.mutation(api.matches.shareSource, { matchId });
		expect((await a.query(api.matches.view, { matchId })).rounds[0].sharedSource).toBe(
			'original guest private source'
		);
	});
	it('enforces separate player-wide scored and sample slots and cooldowns across concurrent matches', async () => {
		vi.useFakeTimers();
		const t = harness();
		const first = await start(t);
		const secondRoom = await first.a.mutation(api.rooms.create, {});
		await first.b.mutation(api.rooms.join, secondRoom);
		for (const client of [first.a, first.b]) {
			await client.mutation(api.decks.set, { roomId: secondRoom.roomId, cardIds: deck });
			await client.mutation(api.rooms.setReady, { roomId: secondRoom.roomId, ready: true });
		}
		await vi.advanceTimersByTimeAsync(3100);
		await t.finishInProgressScheduledFunctions();
		const room = await first.a.query(api.rooms.view, { roomId: secondRoom.roomId });
		const second = await first.a.query(api.matches.view, { matchId: present(room.currentMatchId) });
		await t.mutation(internal.ops.setJudging, { enabled: true });
		const scored = (roundId: typeof first.roundId, clientSubmitId: string) =>
			first.a.mutation(api.submissions.submit, { roundId, source: 'score', clientSubmitId });
		const sample = (roundId: typeof first.roundId, clientRunId: string) =>
			first.a.mutation(api.samples.run, { roundId, source: 'sample', clientRunId });
		await scored(first.roundId, 'global-score-1');
		await expect(scored(second.round.roundId, 'global-score-2')).rejects.toThrow('BAD_STATE');
		await sample(second.round.roundId, 'global-sample-1');
		await expect(sample(first.roundId, 'global-sample-2')).rejects.toThrow('BAD_STATE');
		for (const job of await claimAll(t))
			await t.mutation(internal.judge._complete, {
				attemptId: job.attemptId,
				leaseVersion: job.leaseVersion,
				result: result('WA')
			});
		await expect(scored(second.round.roundId, 'global-score-2')).rejects.toThrow('COOLDOWN');
		await expect(sample(first.roundId, 'global-sample-2')).rejects.toThrow('COOLDOWN');
		vi.setSystemTime(Date.now() + 3100);
		await scored(second.round.roundId, 'global-score-2');
		await expect(sample(first.roundId, 'global-sample-2')).rejects.toThrow('COOLDOWN');
		vi.setSystemTime(Date.now() + 2100);
		await sample(first.roundId, 'global-sample-2');
		expect(
			(await first.a.query(api.matches.view, { matchId: first.matchId })).ownSampleRuns
		).toHaveLength(1);
		expect(
			(await first.a.query(api.matches.view, { matchId: second.matchId })).ownSubmissions
		).toHaveLength(1);
	});
	it.each([
		{ signal: 'none', started: false, voided: true },
		{ signal: 'none', started: true, voided: false },
		{ signal: 'unrelated platform', started: true, voided: false },
		{ signal: 'operator', started: true, voided: true },
		{ signal: 'same submission platform', started: true, voided: true }
	])(
		'attributes dispatch loss with started=$started and signal=$signal',
		async ({ signal, started, voided }) => {
			vi.useFakeTimers();
			const t = convexTest(schema, {
				...modules,
				'../../convex/judgeController.ts': () => import('./unavailableJudge.fixture')
			});
			const { a, b, matchId, roundId } = await start(t);
			await t.mutation(internal.ops.setJudging, { enabled: true });
			if (signal === 'unrelated platform') {
				// Real preflight failure on another player's sample, outside any contestant window.
				await b.mutation(api.samples.run, { roundId, source: 'sample', clientRunId: 'unrelated' });
				const [sample] = await t.mutation(internal.judge._pump, {});
				await t.action(internal.judgeDispatch._run, sample);
			}
			if (signal === 'operator')
				await t.mutation(internal.ops.declareIncident, { code: 'CONFIRMED_OUTAGE' });
			const submitted = await a.mutation(api.submissions.submit, {
				roundId,
				source: 'dispatch loss',
				clientSubmitId: 'loss'
			});
			for (let attempt = 0; attempt < 2; attempt++) {
				const [job] = await t.mutation(internal.judge._pump, {});
				if (started && !(signal === 'same submission platform' && attempt === 0)) {
					await t.mutation(internal.judge._claim, job);
					await t.mutation(internal.judge._noteContestantStart, { ...job, stage: 'run' });
				}
				await t.action(internal.judgeDispatch._run, job);
			}
			const rival = await b.mutation(api.submissions.submit, {
				roundId,
				source: 'accepted rival',
				clientSubmitId: 'rival'
			});
			const [job] = await claimAll(t);
			await t.mutation(internal.judge._complete, {
				attemptId: job.attemptId,
				leaseVersion: job.leaseVersion,
				result: result('AC')
			});
			const view = await a.query(api.matches.view, { matchId });
			expect(view.rounds[0].ownSubmissions[0]).toMatchObject({
				submissionId: submitted.submissionId,
				status: voided ? 'judge_failed' : 'done',
				verdict: voided ? 'IE' : 'RE'
			});
			expect(view.rounds[0].outcome).toBe(voided ? 'void' : 'won');
			expect(view.rounds[0].winningSubmissionId).toBe(voided ? null : rival.submissionId);
		}
	);
	it('purges seven-day private payloads while retaining verdict history and source consent tombstones', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { a, b, matchId, roundId } = await start(t);
		await t.mutation(internal.ops.setJudging, { enabled: true });
		const admitted = await a.mutation(api.submissions.submit, {
			roundId,
			source: 'sensitive source',
			clientSubmitId: 'purge-score'
		});
		await a.mutation(api.samples.run, {
			roundId,
			source: 'sample source',
			clientRunId: 'purge-sample'
		});
		for (const job of await claimAll(t))
			await t.mutation(internal.judge._complete, {
				attemptId: job.attemptId,
				leaseVersion: job.leaseVersion,
				result: {
					...result('CE'),
					phase: 'sample',
					diagnostics: 'private diagnostic',
					sampleFeedback: {
						input: 'private input',
						expected: 'private expected',
						actual: 'private actual'
					},
					sampleResults: [{ verdict: 'WA', output: 'private output' }]
				}
			});
		// Fifty-one sample jobs cross the purge page boundary through real admissions.
		for (let i = 0; i < 25; i++) {
			vi.setSystemTime(Date.now() + 5100);
			for (const client of [a, b])
				await client.mutation(api.samples.run, {
					roundId,
					source: 'sample source',
					clientRunId: `purge-page-${i}`
				});
			for (const job of await claimAll(t))
				await t.mutation(internal.judge._complete, {
					attemptId: job.attemptId,
					leaseVersion: job.leaseVersion,
					result: {
						...result('WA'),
						phase: 'sample',
						sampleResults: [{ verdict: 'WA', output: 'private output' }]
					}
				});
		}
		await a.mutation(api.matches.concede, { matchId });
		await a.mutation(api.matches.shareSource, { matchId });
		const before = await a.query(api.matches.view, { matchId });
		expect(before.ownSubmissions[0].diagnostics).toBe('private diagnostic');
		expect(before.ownSampleRuns[0].results).toEqual([{ verdict: 'WA', output: 'private output' }]);
		vi.setSystemTime(Date.now() + 7 * 86400000 + 100);
		await t.mutation(internal.ops._purge, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const after = await a.query(api.matches.view, { matchId });
		expect(after.ownSubmissions[0]).toMatchObject({
			submissionId: admitted.submissionId,
			source: null,
			verdict: 'CE',
			status: 'done',
			purgedAt: expect.any(Number)
		});
		expect(after.ownSampleRuns).toHaveLength(26);
		const opponentHistory = await b.query(api.matches.view, { matchId });
		expect(opponentHistory.ownSampleRuns).toHaveLength(25);
		for (const run of [...after.ownSampleRuns, ...opponentHistory.ownSampleRuns])
			expect(run).toMatchObject({ results: null, diagnostics: null, purgedAt: expect.any(Number) });
		expect(JSON.stringify(after)).not.toMatch(
			/sensitive source|private diagnostic|private input|private expected|private actual|private output/
		);
		expect((await b.query(api.matches.view, { matchId })).rounds[0].sharedSource).toBeNull();
		expect(
			await a.mutation(api.submissions.submit, {
				roundId,
				source: 'sensitive source',
				clientSubmitId: 'purge-score'
			})
		).toEqual(admitted);
	});
	it('expires finished history after thirty days and preserves newer match outcomes', async () => {
		vi.useFakeTimers();
		const t = harness();
		const old = await start(t);
		await old.a.mutation(api.matches.concede, { matchId: old.matchId });
		vi.setSystemTime(Date.now() + 29 * 86400000);
		await t.mutation(internal.ops._purge, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await old.b.query(api.matches.view, { matchId: old.matchId })).reason).toBe('concede');
		for (const client of [old.a, old.b])
			await client.mutation(api.rooms.requestRematch, { roomId: old.roomId });
		for (const client of [old.a, old.b]) {
			await client.mutation(api.decks.set, { roomId: old.roomId, cardIds: deck });
			await client.mutation(api.rooms.setReady, { roomId: old.roomId, ready: true });
		}
		await vi.advanceTimersByTimeAsync(3100);
		await t.finishInProgressScheduledFunctions();
		const current = present(
			(await old.a.query(api.rooms.view, { roomId: old.roomId })).currentMatchId
		);
		await old.a.mutation(api.matches.concede, { matchId: current });
		vi.setSystemTime(Date.now() + 2 * 86400000);
		await t.mutation(internal.ops._purge, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		await expect(old.a.query(api.matches.view, { matchId: old.matchId })).rejects.toThrow(
			'NOT_FOUND'
		);
		expect((await old.b.query(api.matches.view, { matchId: current })).reason).toBe('concede');
		expect((await old.a.query(api.rooms.view, { roomId: old.roomId })).currentMatchId).toBe(
			current
		);
	});
	it('lets an operator annul a finished match without awarding either player or mutating active matches', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { a, b, matchId } = await start(t);
		await expect(
			t.mutation(internal.ops.annulMatch, { matchId, note: 'operator context' })
		).rejects.toThrow('BAD_STATE');
		await a.mutation(api.matches.concede, { matchId });
		await t.mutation(internal.ops.annulMatch, { matchId, note: 'private incident context' });
		await t.mutation(internal.ops.annulMatch, { matchId, note: 'duplicate request' });
		for (const client of [a, b]) {
			const view = await client.query(api.matches.view, { matchId });
			expect(view).toMatchObject({
				status: 'finished',
				result: 'aborted',
				winnerId: null,
				reason: 'annulled_by_operator'
			});
			expect(JSON.stringify(view)).not.toContain('private incident context');
		}
	});
	it('validates free-budget caps and applies operator limits to real dispatch admission', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { a, b, roundId } = await start(t);
		const caps = {
			maxInFlight: 1,
			dailySecondsCap: 40,
			monthlySecondsCap: 80,
			monthlyActionSecondsCap: 90
		};
		for (const invalid of [
			{ maxInFlight: 11 },
			{ maxInFlight: 1.5 },
			{ dailySecondsCap: 12001 },
			{ dailySecondsCap: 0 },
			{ monthlySecondsCap: 250001 },
			{ monthlySecondsCap: Number.NaN },
			{ monthlyActionSecondsCap: 115201 },
			{ monthlyActionSecondsCap: Number.POSITIVE_INFINITY }
		])
			await expect(t.mutation(internal.ops.setCaps, { ...caps, ...invalid })).rejects.toThrow(
				'BAD_INPUT'
			);
		await t.mutation(internal.ops.setCaps, caps);
		await t.mutation(internal.ops.setJudging, { enabled: true });
		await a.mutation(api.submissions.submit, { roundId, source: 'one', clientSubmitId: 'cap-one' });
		await b.mutation(api.submissions.submit, { roundId, source: 'two', clientSubmitId: 'cap-two' });
		const jobs = await claimAll(t);
		expect(jobs).toHaveLength(1);
		await t.mutation(internal.judge._complete, {
			attemptId: jobs[0].attemptId,
			leaseVersion: jobs[0].leaseVersion,
			result: { ...result('WA'), sandboxSeconds: 40 }
		});
		await t.mutation(internal.judge._pump, {});
		vi.setSystemTime(Date.now() + 3100);
		await expect(
			a.mutation(api.samples.run, { roundId, source: 'after cap', clientRunId: 'cap-block' })
		).rejects.toThrow('PAUSED');
	});
	it.each([
		{ timing: 'WA measurements', censored: false },
		{ timing: 'censored TLE measurements', censored: true }
	])(
		'reports private $timing with a fixed scored denominator and seven-day retention',
		async ({ censored }) => {
			vi.useFakeTimers();
			const t = harness();
			const { a, b, matchId, roundId, roomId } = await start(t);
			await t.mutation(internal.ops.setJudging, { enabled: true });
			let versionId: FunctionArgs<typeof internal.ops.timingReport>['problemVersionId'] | undefined;
			for (let i = 0; i < 21; i++) {
				await a.mutation(api.submissions.submit, {
					roundId,
					source: `timing source ${i}`,
					clientSubmitId: `timing-${i}`
				});
				const [job] = await claimAll(t);
				versionId = present(job.claim).snapshot.problemVersionId;
				await t.mutation(internal.judge._complete, {
					attemptId: job.attemptId,
					leaseVersion: job.leaseVersion,
					result: {
						...result(censored && i < 19 ? 'TLE' : 'WA'),
						metrics: {
							testWallMs: [censored ? (i < 19 ? 500 : 450) : i === 1 || i === 20 ? 450 : 100],
							execObservedMs: [550]
						}
					}
				});
				if ((!censored && i === 18) || i === 19)
					expect(
						await t.query(internal.ops.timingReport, { problemVersionId: versionId })
					).toMatchObject({
						scored: i + 1,
						measured: censored ? 1 : i + 1,
						nearThreshold: 1,
						status: 'active'
					});
				vi.setSystemTime(Date.now() + 3100);
			}
			expect(
				await t.query(internal.ops.timingReport, { problemVersionId: present(versionId) })
			).toMatchObject({
				scored: 20,
				measured: censored ? 2 : 20,
				nearThreshold: 2,
				status: 'calibrating'
			});
			const publicView = await b.query(api.matches.view, { matchId });
			expect(JSON.stringify(publicView)).not.toMatch(/testWallMs|execObservedMs|nearThreshold/);
			await a.mutation(api.matches.concede, { matchId });
			for (const client of [a, b]) await client.mutation(api.rooms.requestRematch, { roomId });
			for (const client of [a, b]) await client.mutation(api.decks.set, { roomId, cardIds: deck });
			await a.mutation(api.rooms.setReady, { roomId, ready: true });
			await expect(b.mutation(api.rooms.setReady, { roomId, ready: true })).rejects.toThrow(
				'BAD_STATE'
			);
			vi.setSystemTime(Date.now() + 7 * 86400000 + 100);
			await t.mutation(internal.ops._purge, {});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			expect(
				await t.query(internal.ops.timingReport, { problemVersionId: present(versionId) })
			).toMatchObject({ scored: 20, measured: 0, nearThreshold: 0, status: 'calibrating' });
		}
	);
	it('requires Clerk identity and creates one private player mapping idempotently', async () => {
		const t = harness();
		await expect(t.query(api.players.me, {})).rejects.toThrow('AUTH_INVALID');
		const a = t.withIdentity({ tokenIdentifier: 'issuer|alice', subject: 'alice' });
		expect(await a.query(api.players.me, {})).toBeNull();
		await expect(a.mutation(api.players.ensure, { displayName: 'x\n' })).rejects.toThrow(
			'BAD_INPUT'
		);
		const one = await a.mutation(api.players.ensure, { displayName: '  Alice  ' });
		const two = await a.mutation(api.players.ensure, { displayName: 'Ignored' });
		expect(two).toEqual(one);
		expect(await a.query(api.players.me, {})).toEqual({
			playerId: one.playerId,
			displayName: 'Alice',
			canHost: false
		});
		await expect(a.mutation(api.rooms.create, {})).rejects.toThrow('DISABLED');
	});
	it('redeems a single-use host pass and protects the one invited seat and member view', async () => {
		const t = harness();
		const a = t.withIdentity({ tokenIdentifier: 'issuer|a' });
		const b = t.withIdentity({ tokenIdentifier: 'issuer|b' });
		const outsider = t.withIdentity({ tokenIdentifier: 'issuer|c' });
		for (const [client, name] of [
			[a, 'Alice'],
			[b, 'Bobby'],
			[outsider, 'Chris']
		] as const)
			await client.mutation(api.players.ensure, { displayName: name });
		const { code } = await t.mutation(internal.ops.mintHostPass, { note: 'test operator' });
		await a.mutation(api.players.redeemHostPass, { code });
		await expect(b.mutation(api.players.redeemHostPass, { code })).rejects.toThrow('BAD_INPUT');
		const room = await a.mutation(api.rooms.create, {});
		await expect(outsider.query(api.rooms.view, { roomId: room.roomId })).rejects.toThrow(
			'NOT_FOUND'
		);
		expect(await b.mutation(api.rooms.join, { ...room, inviteToken: 'wrong' })).toMatchObject({
			ok: false
		});
		expect(await b.mutation(api.rooms.join, room)).toMatchObject({ ok: true });
		expect(await b.mutation(api.rooms.join, room)).toMatchObject({ ok: true });
		expect(await outsider.mutation(api.rooms.join, room)).toMatchObject({ ok: false });
		const view = await b.query(api.rooms.view, { roomId: room.roomId });
		expect(view.status).toBe('lobby');
		expect(view.host.displayName).toBe('Alice');
		expect(JSON.stringify(view)).not.toMatch(/tokenIdentifier|inviteHash|issuer/);
	});

	it('starts only after locked decks and countdown, and reveals only public problem data', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { a, b, roomId } = await lobby(t);
		await seedProblems(t);
		await expect(a.mutation(api.rooms.setReady, { roomId, ready: true })).rejects.toThrow(
			'BAD_INPUT'
		);
		await expect(
			a.mutation(api.decks.set, {
				roomId,
				cardIds: ['light_mode', 'light_mode', 'no_paste', 'no_hints']
			})
		).rejects.toThrow('BAD_INPUT');
		for (const client of [a, b]) await client.mutation(api.decks.set, { roomId, cardIds: deck });
		expect(await a.query(api.rooms.view, { roomId })).toMatchObject({
			ownDeck: deck,
			opponentDeck: null
		});
		await a.mutation(api.rooms.setReady, { roomId, ready: true });
		await b.mutation(api.rooms.setReady, { roomId, ready: true });
		await a.mutation(api.rooms.setReady, { roomId, ready: false });
		await vi.advanceTimersByTimeAsync(3000);
		await t.finishInProgressScheduledFunctions();
		expect((await a.query(api.rooms.view, { roomId })).currentMatchId).toBeNull();
		await a.mutation(api.rooms.setReady, { roomId, ready: true });
		await vi.advanceTimersByTimeAsync(3000);
		await t.finishInProgressScheduledFunctions();
		const room = await a.query(api.rooms.view, { roomId });
		expect(room).toMatchObject({ ownDeck: deck, opponentDeck: deck });
		const match = await a.query(api.matches.view, { matchId: present(room.currentMatchId) });
		expect(match.status).toBe('active');
		expect(match.round.status).toBe('active');
		expect(match.round.endsAt - match.round.startsAt).toBe(600000);
		expect(match.players.map((p: { power: number }) => p.power)).toEqual([3, 3]);
		expect(present(match.problem).samples).toEqual([{ input: '2 3', output: '5' }]);
		expect(JSON.stringify(match)).not.toMatch(
			/private-sha|private-package|testsStorageId|testCount|tokenIdentifier/
		);
		await expect(b.mutation(api.decks.set, { roomId, cardIds: deck })).rejects.toThrow('BAD_STATE');
		await vi.advanceTimersByTimeAsync(600000);
		await t.finishInProgressScheduledFunctions();
		const later = await a.query(api.matches.view, { matchId: present(room.currentMatchId) });
		expect(later.round.status).toBe('intermission');
		expect(later.rounds[0].outcome).toBe('drawn');
	});

	it('spends regenerated power once per card, applies timed challenges, and discards capped ticks', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { a, b, matchId, roundId } = await start(t);
		const play = await a.mutation(api.cards.play, {
			roundId,
			cardId: 'brain_teaser',
			clientPlayId: 'teaser-1'
		});
		expect(
			await a.mutation(api.cards.play, {
				roundId,
				cardId: 'brain_teaser',
				clientPlayId: 'teaser-1'
			})
		).toEqual(play);
		let view = await b.query(api.matches.view, { matchId });
		expect(view.players[0].power).toBe(0);
		const challenge = present(view.effects.find((e) => e.cardId === 'brain_teaser'));
		const operands = present(challenge.challenge);
		await expect(
			a.mutation(api.cards.answerChallenge, { roundId, effectId: challenge.effectId, answer: 0 })
		).rejects.toThrow('NOT_FOUND');
		expect(
			await b.mutation(api.cards.answerChallenge, {
				roundId,
				effectId: challenge.effectId,
				answer: 0
			})
		).toEqual({ solved: false });
		await expect(
			b.mutation(api.cards.answerChallenge, { roundId, effectId: challenge.effectId, answer: 0 })
		).rejects.toThrow('COOLDOWN');
		expect(
			await b.mutation(api.cards.answerChallenge, {
				roundId,
				effectId: challenge.effectId,
				answer: operands.a + operands.b
			})
		).toEqual({ solved: true });
		await vi.advanceTimersByTimeAsync(200000);
		// The refreshed balance and its public tick must share one server snapshot.
		// Otherwise a client can credit elapsed ticks a second time after clock correction.
		view = await b.query(api.matches.view, { matchId });
		expect(view.players[0]).toMatchObject({ power: 10, powerTick: 20 });
		await a.mutation(api.cards.play, { roundId, cardId: 'strict_compile', clientPlayId: 'strict' });
		await vi.advanceTimersByTimeAsync(2100);
		await a.mutation(api.cards.play, { roundId, cardId: 'no_paste', clientPlayId: 'paste' });
		view = await b.query(api.matches.view, { matchId });
		expect(view.players[0].power).toBe(4);
		expect(view.effects.map((e: { cardId: string }) => e.cardId).sort()).toEqual([
			'no_paste',
			'strict_compile'
		]);
		await expect(
			a.mutation(api.cards.play, { roundId, cardId: 'no_hints', clientPlayId: 'not-in-deck' })
		).rejects.toThrow('BAD_INPUT');
		await expect(
			a.mutation(api.cards.play, { roundId, cardId: 'brain_teaser', clientPlayId: 'again' })
		).rejects.toThrow('CHARGE');
	});

	it('admits immutable strict source once, enforces challenge/one outstanding, and hides opponent work', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { a, b, matchId, roundId } = await start(t);
		await t.mutation(internal.ops.setJudging, { enabled: true });
		await a.mutation(api.cards.play, { roundId, cardId: 'brain_teaser', clientPlayId: 'teaser' });
		await expect(
			b.mutation(api.submissions.submit, {
				roundId,
				source: 'opaque source',
				clientSubmitId: 'blocked'
			})
		).rejects.toThrow('CHALLENGE');
		await vi.advanceTimersByTimeAsync(40100);
		await a.mutation(api.cards.play, { roundId, cardId: 'strict_compile', clientPlayId: 'strict' });
		await expect(
			b.mutation(api.submissions.submit, { roundId, source: '', clientSubmitId: 'empty' })
		).rejects.toThrow('BAD_INPUT');
		const first = await b.mutation(api.submissions.submit, {
			roundId,
			source: 'exact admitted bytes',
			clientSubmitId: 'one'
		});
		expect(
			await b.mutation(api.submissions.submit, {
				roundId,
				source: 'exact admitted bytes',
				clientSubmitId: 'one'
			})
		).toEqual(first);
		await expect(
			b.mutation(api.submissions.submit, {
				roundId,
				source: 'replaced bytes',
				clientSubmitId: 'one'
			})
		).rejects.toThrow('BAD_INPUT');
		await expect(
			b.mutation(api.submissions.submit, { roundId, source: 'another', clientSubmitId: 'two' })
		).rejects.toThrow('BAD_STATE');
		const own = await b.query(api.matches.view, { matchId });
		expect(own.ownSubmissions).toEqual([
			expect.objectContaining({
				submissionId: first.submissionId,
				source: 'exact admitted bytes',
				profile: 'strict',
				status: 'pending',
				seq: first.seq
			})
		]);
		expect(own.effects.some((e: { cardId: string }) => e.cardId === 'strict_compile')).toBe(false);
		const opponent = await a.query(api.matches.view, { matchId });
		expect(opponent.opponentPending).toBe(true);
		expect(opponent.ownSubmissions).toEqual([]);
		expect(JSON.stringify(opponent)).not.toContain('exact admitted bytes');
		await expect(
			b.mutation(api.submissions.submit, {
				roundId,
				source: 'x',
				clientSubmitId: 'forged',
				// @ts-expect-error Deliberately invalid public payload must be rejected by validation.
				verdict: 'AC'
			})
		).rejects.toThrow();
	});

	it('withholds a provisional acceptance and awards the earliest admitted accepted source regardless of completion order', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { a, b, matchId, roundId } = await start(t);
		await t.mutation(internal.ops.setJudging, { enabled: true });
		const first = await a.mutation(api.submissions.submit, {
			roundId,
			source: 'earlier',
			clientSubmitId: 'early'
		});
		const second = await b.mutation(api.submissions.submit, {
			roundId,
			source: 'later',
			clientSubmitId: 'late'
		});
		const jobs = await claimAll(t);
		const early = jobs.find((j) => j.claim?.submissionId === first.submissionId)!;
		const late = jobs.find((j) => j.claim?.submissionId === second.submissionId)!;
		await t.mutation(internal.judge._complete, {
			attemptId: late.attemptId,
			leaseVersion: late.leaseVersion + 1,
			result: result('AC')
		});
		expect((await a.query(api.matches.view, { matchId })).round.status).toBe('active');
		await t.mutation(internal.judge._complete, {
			attemptId: late.attemptId,
			leaseVersion: late.leaseVersion,
			result: result('AC')
		});
		for (const client of [a, b]) {
			const view = await client.query(api.matches.view, { matchId });
			expect(view.round.status).toBe('settling');
			expect(view.round.winnerId).toBeNull();
			expect(view.ownSubmissions[0].verdict).toBeNull();
			expect(view.opponentPending).toBeNull();
		}
		await expect(
			a.mutation(api.submissions.submit, { roundId, source: 'closed', clientSubmitId: 'closed' })
		).rejects.toThrow('BAD_STATE');
		await t.mutation(internal.judge._complete, {
			attemptId: early.attemptId,
			leaseVersion: early.leaseVersion,
			result: result('AC')
		});
		let view = await a.query(api.matches.view, { matchId });
		expect(view.rounds[0]).toMatchObject({
			outcome: 'won',
			winnerId: view.playerId,
			winningSubmissionId: first.submissionId
		});
		expect(view.wins).toEqual({ a: 1, b: 0 });
		await t.mutation(internal.judge._complete, {
			attemptId: late.attemptId,
			leaseVersion: late.leaseVersion,
			result: result('WA')
		});
		view = await a.query(api.matches.view, { matchId });
		expect(view.wins).toEqual({ a: 1, b: 0 });
	});

	it('bounds queued work at 90 seconds, replaces one infrastructure void, and aborts a second void', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { a, matchId, roundId } = await start(t);
		await expect(
			a.mutation(api.submissions.submit, {
				roundId,
				source: 'not admitted',
				clientSubmitId: 'paused'
			})
		).rejects.toThrow('PAUSED');
		await t.mutation(internal.ops.setJudging, { enabled: true });
		await a.mutation(api.submissions.submit, { roundId, source: 'queued', clientSubmitId: 'q1' });
		await t.mutation(internal.ops.setJudging, { enabled: false });
		await vi.advanceTimersByTimeAsync(90100);
		await t.finishInProgressScheduledFunctions();
		// No AC exists: the live round remains active until its deadline.
		expect((await a.query(api.matches.view, { matchId })).round.status).toBe('active');
		await vi.advanceTimersByTimeAsync(510100);
		await t.finishInProgressScheduledFunctions();
		let view = await a.query(api.matches.view, { matchId });
		expect(view.rounds[0].outcome).toBe('void');
		expect(view.wins).toEqual({ a: 0, b: 0 });
		expect(view.round.slot).toBe(1);
		await vi.advanceTimersByTimeAsync(20100);
		await t.finishInProgressScheduledFunctions();
		view = await a.query(api.matches.view, { matchId });
		await t.mutation(internal.ops.setJudging, { enabled: true });
		await a.mutation(api.submissions.submit, {
			roundId: view.round.roundId,
			source: 'queued again',
			clientSubmitId: 'q2'
		});
		await t.mutation(internal.ops.setJudging, { enabled: false });
		await vi.advanceTimersByTimeAsync(600100);
		await t.finishInProgressScheduledFunctions();
		view = await a.query(api.matches.view, { matchId });
		expect(view.status).toBe('finished');
		expect(view.result).toBe('aborted');
		expect(view.reason).toBe('void_limit');
		expect(view.winnerId).toBeNull();
	});

	it('treats an uncorroborated lost run as a contestant failure at the ceiling instead of letting it void a rival win', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { a, b, matchId, roundId } = await start(t);
		await t.mutation(internal.ops.setJudging, { enabled: true });
		const first = await a.mutation(api.submissions.submit, {
			roundId,
			source: 'lost run',
			clientSubmitId: 'lost'
		});
		const second = await b.mutation(api.submissions.submit, {
			roundId,
			source: 'valid result',
			clientSubmitId: 'winner'
		});
		const jobs = await claimAll(t);
		const early = jobs.find((j) => j.claim?.submissionId === first.submissionId)!;
		const late = jobs.find((j) => j.claim?.submissionId === second.submissionId)!;
		await t.mutation(internal.judge._noteContestantStart, {
			attemptId: early.attemptId,
			leaseVersion: early.leaseVersion,
			stage: 'run'
		});
		await t.mutation(internal.judge._fail, {
			attemptId: early.attemptId,
			leaseVersion: early.leaseVersion,
			failureClass: 'sandbox_lost',
			code: 'SANDBOX_GONE'
		});
		await t.mutation(internal.ops.setJudging, { enabled: false });
		await t.mutation(internal.judge._complete, {
			attemptId: late.attemptId,
			leaseVersion: late.leaseVersion,
			result: result('AC')
		});
		vi.setSystemTime(Date.now() + 90100);
		await t.mutation(internal.ops.setJudging, { enabled: true });
		await t.mutation(internal.judge._pump, {});
		const view = await a.query(api.matches.view, { matchId });
		const bob = await b.query(api.players.me, {});
		expect(view.rounds[0]).toMatchObject({
			outcome: 'won',
			winnerId: present(bob).playerId,
			winningSubmissionId: second.submissionId
		});
		expect(view.rounds[0].ownSubmissions[0].verdict).toBe('RE');
	});

	it('preserves the aggregate sample verdict independently of completed per-sample results', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { a, b, matchId, roundId } = await start(t);
		await t.mutation(internal.ops.setJudging, { enabled: true });
		await a.mutation(api.samples.run, {
			roundId,
			source: 'sample source',
			clientRunId: 'aggregate'
		});
		const [job] = await claimAll(t);
		await t.mutation(internal.judge._complete, {
			attemptId: job.attemptId,
			leaseVersion: job.leaseVersion,
			result: { ...result('TLE'), phase: 'sample', sampleResults: [{ verdict: 'AC', output: '5' }] }
		});
		expect((await a.query(api.matches.view, { matchId })).ownSampleRuns[0]).toMatchObject({
			status: 'done',
			verdict: 'TLE',
			results: [{ verdict: 'AC', output: '5' }]
		});
		expect((await b.query(api.matches.view, { matchId })).ownSampleRuns).toEqual([]);
	});

	it('runs only public samples during brain teaser without consuming strict compile or exposing sample output to the opponent', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { a, b, matchId, roundId } = await start(t);
		await t.mutation(internal.ops.setJudging, { enabled: true });
		await vi.advanceTimersByTimeAsync(40100);
		await a.mutation(api.cards.play, { roundId, cardId: 'strict_compile', clientPlayId: 'strict' });
		await vi.advanceTimersByTimeAsync(2100);
		await a.mutation(api.cards.play, { roundId, cardId: 'brain_teaser', clientPlayId: 'teaser' });
		const sample = await b.mutation(api.samples.run, {
			roundId,
			source: 'sample-only source',
			clientRunId: 'sample-one'
		});
		await expect(
			b.mutation(api.samples.run, { roundId, source: 'second sample', clientRunId: 'sample-two' })
		).rejects.toThrow('BAD_STATE');
		const jobs = await claimAll(t);
		const job = jobs.find((j) => j.claim?.sampleRunId === sample.sampleRunId)!;
		await t.mutation(internal.judge._complete, {
			attemptId: job.attemptId,
			leaseVersion: job.leaseVersion,
			result: { ...result('AC'), phase: 'sample', sampleResults: [{ verdict: 'AC', output: '5' }] }
		});
		const own = await b.query(api.matches.view, { matchId });
		expect(own.ownSampleRuns).toEqual([
			expect.objectContaining({
				sampleRunId: sample.sampleRunId,
				status: 'done',
				results: [{ verdict: 'AC', output: '5' }]
			})
		]);
		expect(own.effects.some((e: { cardId: string }) => e.cardId === 'strict_compile')).toBe(true);
		const other = await a.query(api.matches.view, { matchId });
		expect(other.ownSampleRuns).toEqual([]);
		expect(JSON.stringify(other)).not.toContain('sample-only source');
	});

	it('ends a conceded match, shares source only by explicit consent, and starts a clean rematch lobby', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { a, b, matchId, roomId, roundId } = await start(t);
		await t.mutation(internal.ops.setJudging, { enabled: true });
		await a.mutation(api.submissions.submit, {
			roundId,
			source: 'private final source',
			clientSubmitId: 'final'
		});
		await a.mutation(api.cards.play, { roundId, cardId: 'light_mode', clientPlayId: 'light' });
		await a.mutation(api.matches.concede, { matchId });
		let view = await b.query(api.matches.view, { matchId });
		expect(view.status).toBe('finished');
		expect(view.reason).toBe('concede');
		expect(view.winnerId).toBe(view.playerId);
		expect(view.round.status).toBe('finished');
		expect(view.effects).toEqual([]);
		expect(JSON.stringify(view)).not.toContain('private final source');
		await a.mutation(api.matches.shareSource, { matchId });
		view = await b.query(api.matches.view, { matchId });
		expect(view.rounds[0].sharedSource).toBe('private final source');
		await a.mutation(api.rooms.requestRematch, { roomId });
		expect((await b.query(api.rooms.view, { roomId })).status).toBe('results');
		await b.mutation(api.rooms.requestRematch, { roomId });
		const room = await a.query(api.rooms.view, { roomId });
		expect(room.status).toBe('lobby');
		expect(room.ready).toEqual({ host: false, guest: false });
		await a.mutation(api.decks.set, { roomId, cardIds: deck });
	});

	it('requires a connected claimant after 120 seconds absence and closes idle rooms after 30 minutes', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { a, b, matchId, roomId } = await start(t);
		await expect(a.mutation(api.matches.claimForfeit, { matchId })).rejects.toThrow('BAD_STATE');
		await vi.advanceTimersByTimeAsync(121000);
		await expect(a.mutation(api.matches.claimForfeit, { matchId })).rejects.toThrow('BAD_STATE');
		await a.mutation(api.presence.heartbeat, { roomId });
		await a.mutation(api.matches.claimForfeit, { matchId });
		expect(await b.query(api.matches.view, { matchId })).toMatchObject({
			status: 'finished',
			reason: 'forfeit'
		});
		await vi.advanceTimersByTimeAsync(1800100);
		await t.mutation(internal.rooms._reap, {});
		expect((await a.query(api.rooms.view, { roomId })).status).toBe('closed');
		await expect(b.mutation(api.presence.heartbeat, { roomId })).rejects.toThrow('BAD_STATE');
		await expect(t.mutation(api.clock.ping, {})).rejects.toThrow('AUTH_INVALID');
		const clock = await a.mutation(api.clock.ping, {});
		expect(clock.serverNow).toBeGreaterThan(0);
	});

	it('cancels readiness on nickname changes and persists invitation abuse limits across rejected joins', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { a, b, roomId } = await lobby(t);
		await seedProblems(t);
		for (const client of [a, b]) {
			await client.mutation(api.decks.set, { roomId, cardIds: deck });
			await client.mutation(api.rooms.setReady, { roomId, ready: true });
		}
		await a.mutation(api.players.rename, { displayName: 'New Alice' });
		await vi.advanceTimersByTimeAsync(3100);
		await t.finishInProgressScheduledFunctions();
		expect((await b.query(api.rooms.view, { roomId })).ready.host).toBe(false);
		await b.mutation(api.rooms.leave, { roomId });
		const { inviteToken } = await a.mutation(api.rooms.regenerateInvite, { roomId });
		for (let i = 0; i < 10; i++)
			expect(await b.mutation(api.rooms.join, { roomId, inviteToken: 'bad' })).toMatchObject({
				ok: false,
				error: { code: 'NOT_FOUND' }
			});
		expect(await b.mutation(api.rooms.join, { roomId, inviteToken })).toMatchObject({
			ok: false,
			error: { code: 'QUOTA' }
		});
		await vi.advanceTimersByTimeAsync(3600100);
		expect(await b.mutation(api.rooms.join, { roomId, inviteToken })).toMatchObject({ ok: true });
		expect((await b.query(api.rooms.view, { roomId })).host.displayName).toBe('New Alice');
		await a.mutation(api.rooms.close, { roomId });
		expect((await b.query(api.rooms.view, { roomId })).status).toBe('closed');
	});

	it('resets power and card charges for the next round and finishes best of three at two wins', async () => {
		vi.useFakeTimers();
		const t = harness();
		const game = await start(t);
		await t.mutation(internal.ops.setJudging, { enabled: true });
		let roundId = game.roundId;
		for (let round = 0; round < 2; round++) {
			await game.a.mutation(api.cards.play, {
				roundId,
				cardId: 'light_mode',
				clientPlayId: `light-${round}`
			});
			const submission = await game.a.mutation(api.submissions.submit, {
				roundId,
				source: `source-${round}`,
				clientSubmitId: `win-${round}`
			});
			const jobs = await claimAll(t);
			const job = jobs.find((j) => j.claim?.submissionId === submission.submissionId)!;
			await t.mutation(internal.judge._complete, {
				attemptId: job.attemptId,
				leaseVersion: job.leaseVersion,
				result: result('AC')
			});
			let view = await game.a.query(api.matches.view, { matchId: game.matchId });
			if (round === 0) {
				expect(view.round.status).toBe('intermission');
				roundId = view.round.roundId;
				for (const client of [game.a, game.b])
					await client.mutation(api.rounds.readyNext, { roundId });
				await vi.advanceTimersByTimeAsync(3100);
				await t.finishInProgressScheduledFunctions();
				view = await game.a.query(api.matches.view, { matchId: game.matchId });
				expect(view.players[0]).toMatchObject({ power: 3, usedCards: [] });
				expect(view.effects).toEqual([]);
			} else {
				expect(view.status).toBe('finished');
				expect(view.result).toBe('win');
				expect(view.winnerId).toBe(view.playerId);
				expect(view.wins).toEqual({ a: 2, b: 0 });
				expect(view.rounds).toHaveLength(2);
				await expect(
					game.a.mutation(api.submissions.submit, {
						roundId,
						source: 'too late',
						clientSubmitId: 'over'
					})
				).rejects.toThrow('BAD_STATE');
			}
		}
	});
	it('keeps an operator-revoked Clerk account disabled across ensure and room access', async () => {
		const t = harness();
		const { a, b, roomId } = await lobby(t);
		const alice = await a.query(api.players.me, {});
		await t.mutation(internal.ops.revokePlayer, { playerId: present(alice).playerId });
		await expect(a.query(api.players.me, {})).rejects.toThrow('DISABLED');
		await expect(
			a.mutation(api.players.ensure, { displayName: 'New identity attempt' })
		).rejects.toThrow('DISABLED');
		await expect(a.query(api.rooms.view, { roomId })).rejects.toThrow('DISABLED');
		expect((await b.query(api.rooms.view, { roomId })).host.playerId).toBe(present(alice).playerId);
	});

	it('enforces the 90 second ceiling even if an acceptance races a delayed scheduler callback', async () => {
		vi.useFakeTimers();
		const t = harness();
		const { a, b, matchId, roundId } = await start(t);
		await t.mutation(internal.ops.setJudging, { enabled: true });
		const first = await a.mutation(api.submissions.submit, {
			roundId,
			source: 'too slow',
			clientSubmitId: 'slow'
		});
		const second = await b.mutation(api.submissions.submit, {
			roundId,
			source: 'on time',
			clientSubmitId: 'fast'
		});
		const jobs = await claimAll(t);
		const early = jobs.find((j) => j.claim?.submissionId === first.submissionId)!;
		const late = jobs.find((j) => j.claim?.submissionId === second.submissionId)!;
		await t.mutation(internal.judge._noteContestantStart, {
			attemptId: early.attemptId,
			leaseVersion: early.leaseVersion,
			stage: 'run'
		});
		await t.mutation(internal.judge._complete, {
			attemptId: late.attemptId,
			leaseVersion: late.leaseVersion,
			result: result('AC')
		});
		vi.setSystemTime(Date.now() + 90100);
		await t.mutation(internal.judge._complete, {
			attemptId: early.attemptId,
			leaseVersion: early.leaseVersion,
			result: result('AC')
		});
		const view = await b.query(api.matches.view, { matchId });
		expect(view.rounds[0]).toMatchObject({
			outcome: 'won',
			winnerId: view.playerId,
			winningSubmissionId: second.submissionId
		});
	});
	it.each([false, true])(
		'keeps draft packages private until trusted calibration activates the complete pool; production=%s',
		async (production) => {
			vi.useFakeTimers();
			const t = harness();
			const { a, b, roomId } = await lobby(t);
			const { versions, evidence } = await seedProblems(t, false, production);
			for (const client of [a, b]) await client.mutation(api.decks.set, { roomId, cardIds: deck });
			await a.mutation(api.rooms.setReady, { roomId, ready: true });
			await expect(b.mutation(api.rooms.setReady, { roomId, ready: true })).rejects.toThrow(
				'BAD_STATE'
			);
			const named = {
				...evidence,
				decisionPolicy: {
					name: 'alpha-complexity-all-history-v1' as const,
					policySha256: '0'.repeat(64)
				}
			};
			await expect(
				t.mutation(internal.problems._activate, {
					problemVersionId: versions[0],
					calibration: named
				})
			).rejects.toThrow(production ? 'BAD_STATE' : 'BAD_INPUT');
			await expect(
				t.mutation(
					production
						? internal.problems._activateProduction
						: internal.problems._activateAllHistory,
					{
						problemVersionId: versions[0],
						calibration: named
					}
				)
			).rejects.toThrow('BAD_INPUT');
			// Named-policy summary callers must supply slow validity proof; omission never defaults to pass.
			const boundNamed = {
				...evidence,
				decisionPolicy: {
					name: 'alpha-complexity-all-history-v1' as const,
					policySha256: 'd4e0591e44e994a16dd9ad19166349132f963dd39a64688b5509acb2e1b072ca'
				}
			};
			expect(
				await t.mutation(
					production
						? internal.problems._activateProduction
						: internal.problems._activateAllHistory,
					{
						problemVersionId: versions[0],
						calibration: boundNamed
					}
				)
			).toMatchObject({ activated: false });
			expect(
				await t.mutation(
					production
						? internal.problems._activateProduction
						: internal.problems._activateAllHistory,
					{
						problemVersionId: versions[0],
						calibration: {
							...boundNamed,
							timeLimitExceeded: [
								{ slowestTestMs: Array(8).fill(1500), passed: Array(8).fill(true) }
							]
						}
					}
				)
			).toMatchObject({ activated: true });
			const decisions = await t.run((ctx) => ctx.db.query('auditLog').collect());
			expect(
				decisions
					.filter(
						(r) =>
							r.kind ===
							(production
								? 'calibration-decision-production-phase6-all-history-v1'
								: 'calibration-decision-alpha-complexity-all-history-v1')
					)
					.map((r) => JSON.parse(r.detail))
			).toMatchObject([
				{ priorStatus: 'draft', priorCalibration: null, activated: false },
				{ priorStatus: 'rejected', priorCalibration: boundNamed, activated: true }
			]);
			if (production)
				await expect(
					t.mutation(internal.problems._activateAllHistory, {
						problemVersionId: versions[1],
						calibration: boundNamed
					})
				).rejects.toThrow('PRODUCTION_PHASE6_REQUIRED');
			for (const problemVersionId of versions.slice(1))
				await t.mutation(
					production ? internal.problems._activateProduction : internal.problems._activate,
					{
						problemVersionId,
						calibration: production
							? {
									...boundNamed,
									timeLimitExceeded: [
										{ slowestTestMs: Array(8).fill(1500), passed: Array(8).fill(true) }
									]
								}
							: evidence
					}
				);
			await b.mutation(api.rooms.setReady, { roomId, ready: true });
			await vi.advanceTimersByTimeAsync(3100);
			await t.finishInProgressScheduledFunctions();
			const room = await a.query(api.rooms.view, { roomId });
			const view = await a.query(api.matches.view, { matchId: present(room.currentMatchId) });
			expect(present(view.problem).statementMd).toBe('Read two integers and print their sum.');
			expect(present(view.problem).limits.timeMs).toBe(500);
			expect(JSON.stringify(view)).not.toMatch(
				/referenceSolutions|fixture accepted source|testsSha256|environmentSha256|decisionPolicy|policySha256|evidenceSha256|priorCalibration|productionBaseline|productionDecision|originVersionId/
			);
		}
	);
});
