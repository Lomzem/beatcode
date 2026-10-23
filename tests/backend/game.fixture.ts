import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { convexTest } from 'convex-test';
import type { FunctionArgs } from 'convex/server';
import { api, internal } from '../../convex/_generated/api';
type harness = typeof convexTest;
export function present<T>(value: T | null | undefined): T {
	if (value == null) throw new Error('Required fixture/API value missing');
	return value;
}
export async function lobby(t: ReturnType<harness>) {
	const a = t.withIdentity({ tokenIdentifier: 'issuer|alice' });
	const b = t.withIdentity({ tokenIdentifier: 'issuer|bob' });
	await a.mutation(api.players.ensure, { displayName: 'Alice' });
	await b.mutation(api.players.ensure, { displayName: 'Bobby' });
	const { code } = await t.mutation(internal.ops.mintHostPass, { note: 'fixture' });
	await a.mutation(api.players.redeemHostPass, { code });
	const room = await a.mutation(api.rooms.create, {});
	await b.mutation(api.rooms.join, room);
	return { a, b, roomId: room.roomId };
}
export async function seedProblems(t: ReturnType<harness>, activate = true) {
	// Trusted publishing/measurement fixtures only; these are NOT cloud calibration evidence.
	const env = {
		envId: 'fixture-env',
		modalImageId: 'im-fixture',
		baseDigest: 'sha256:eb5e64286ad47187b32bda75c6b6916166ecb41da56559b8b09e0001748d2cce',
		gccVersion: '15.3.0',
		runtime: 'gvisor' as const,
		cpu: 1 as const,
		runnerSha256: '0'.repeat(64)
	};
	const { judgeEnvId } = await t.mutation(internal.problems._registerEnvironment, env);
	const bytes = 'private-test-fixture';
	const hash = (text: string) => createHash('sha256').update(text).digest('hex');
	const testsStorageId = await t.run((ctx) => ctx.storage.store(new Blob([bytes])));
	const evidence = {
		environmentSha256: hash(
			JSON.stringify([
				env.envId,
				env.modalImageId,
				env.baseDigest,
				env.gccVersion,
				env.runtime,
				env.cpu,
				env.runnerSha256
			])
		),
		packageSha256: hash(bytes),
		evidenceSha256: '1'.repeat(64),
		validatorPassed: true,
		accepted: [
			{
				passed: Array(8).fill(true),
				slowestTestMs: Array(8).fill(200),
				aggregateMs: Array(8).fill(1000),
				attemptWallMs: Array(8).fill(3000)
			}
		],
		timeLimitExceeded: [{ slowestTestMs: Array(8).fill(1500) }],
		wrongAnswerFailed: [true]
	};
	const versions = [];
	for (let i = 0; i < 6; i++) {
		const { problemVersionId } = await t.mutation(internal.problems._createVersion, {
			slug: `fixture-${i}`,
			title: `Problem ${i}`,
			difficulty: ([1, 1, 2, 2, 3, 3] as const)[i],
			version: 1,
			statementMd: 'Read two integers and print their sum.',
			samples: [{ input: '2 3', output: '5' }],
			limits: { timeMs: 1000, memoryMiB: 256, outputKiB: 64, aggregateMs: 15000 },
			testsStorageId,
			testsSha256: hash(bytes),
			packageSha256: hash(bytes),
			judgeEnvId,
			referenceSolutions: {
				accepted: ['fixture accepted source'],
				timeLimitExceeded: ['fixture slow source'],
				wrongAnswer: ['fixture wrong source'],
				validator: 'fixture validator source'
			}
		});
		versions.push(problemVersionId);
		if (activate)
			await t.mutation(internal.problems._activate, { problemVersionId, calibration: evidence });
	}
	return { versions, evidence };
}

export const deck: FunctionArgs<typeof api.decks.set>['cardIds'] = [
	'light_mode',
	'no_paste',
	'brain_teaser',
	'strict_compile'
];
export async function start(t: ReturnType<harness>) {
	const game = await lobby(t);
	await seedProblems(t);
	for (const client of [game.a, game.b]) {
		await client.mutation(api.decks.set, { roomId: game.roomId, cardIds: deck });
		await client.mutation(api.rooms.setReady, { roomId: game.roomId, ready: true });
	}
	await vi.advanceTimersByTimeAsync(3100);
	await t.finishInProgressScheduledFunctions();
	const room = await game.a.query(api.rooms.view, { roomId: game.roomId });
	const match = await game.a.query(api.matches.view, { matchId: present(room.currentMatchId) });
	return { ...game, matchId: present(room.currentMatchId), roundId: match.round.roundId };
}
