import { it, expect, vi } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../../convex/schema';
import { internal } from '../../convex/_generated/api';
import { sha256 } from '../../judge/controller';
const modules = import.meta.glob('../../convex/**/*.ts');
it('calibration limits concurrency, shares the judging budget and refuses mixed-policy evidence', async () => {
	vi.useFakeTimers();
	try {
		const t = convexTest(schema, modules),
			source = 'int main(){}';
		const { judgeEnvId } = await t.mutation(internal.problems._registerEnvironment, {
			envId: 'test',
			modalImageId: 'im-test',
			baseDigest: 'sha256:' + '0'.repeat(64),
			gccVersion: '15.3.0',
			runtime: 'gvisor',
			cpu: 1,
			runnerSha256: '0'.repeat(64)
		});
		const testsStorageId = await t.run((ctx) => ctx.storage.store(new Blob(['fixture'])));
		const { problemVersionId } = await t.mutation(internal.problems._createVersion, {
			slug: 'fixture',
			title: 'Fixture',
			difficulty: 1,
			version: 1,
			statementMd: 'Fixture',
			samples: [{ input: '1', output: '1' }],
			limits: { timeMs: 3000, memoryMiB: 256, outputKiB: 1, aggregateMs: 15000 },
			testsStorageId,
			testsSha256: sha256('fixture'),
			packageSha256: sha256('package'),
			judgeEnvId,
			referenceSolutions: {
				accepted: [source],
				timeLimitExceeded: [source],
				wrongAnswer: [source],
				validator: source
			}
		});
		const job = {
			problemVersionId,
			role: 'accepted' as const,
			index: 0,
			repeat: 0,
			sourceSha256: sha256(source)
		};
		await expect(
			t.mutation(internal.calibrationState._reserve, { ...job, sourceSha256: 'f'.repeat(64) })
		).rejects.toThrow('CALIBRATION_SOURCE');
		await t.mutation(internal.calibrationState._reserve, job);
		const receipt = (await t.query(internal.calibrationState._status, {})).jobs[0];
		const row = await t.run((ctx) => ctx.db.get(receipt.reservationId));
		const legacy = JSON.parse(row!.detail);
		delete legacy.executionPolicy;
		await t.run((ctx) => ctx.db.patch(receipt.reservationId, { detail: JSON.stringify(legacy) }));
		await expect(
			t.mutation(internal.calibrationState._reserve, { ...job, repeat: 1 })
		).rejects.toThrow('CALIBRATION_POLICY');
		await expect(t.action(internal.calibration._finalize, { problemVersionId })).rejects.toThrow(
			'CALIBRATION_POLICY'
		);
		await t.run((ctx) => ctx.db.patch(receipt.reservationId, { detail: row!.detail }));
		await t.mutation(internal.calibrationState._reserve, { ...job, repeat: 1 });
		await expect(
			t.mutation(internal.calibrationState._reserve, { ...job, repeat: 2 })
		).rejects.toThrow('CALIBRATION_CAPACITY');
		await expect(
			t.mutation(internal.calibrationState._reserve, { ...job, repeat: 8 })
		).rejects.toThrow('CALIBRATION_RETRY_NOT_ALLOWED');
		expect(await t.query(internal.calibrationState._status, {})).toMatchObject({
			reservedSeconds: 80,
			pending: 2
		});
		await t.mutation(internal.ops.setCaps, {
			maxInFlight: 2,
			dailySecondsCap: 80,
			monthlySecondsCap: 80,
			monthlyActionSecondsCap: 10000
		});
		await vi.advanceTimersByTimeAsync(600001);
		await t.finishAllScheduledFunctions(() => vi.runAllTimers());
		await expect(
			t.mutation(internal.calibrationState._reserve, { ...job, repeat: 2 })
		).rejects.toThrow('CALIBRATION_BUDGET');
		expect(await t.query(internal.calibrationState._status, {})).toMatchObject({
			reservedSeconds: 80,
			pending: 0
		});
	} finally {
		vi.useRealTimers();
	}
});
