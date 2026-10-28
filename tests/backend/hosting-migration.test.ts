import { describe, expect, it } from 'vitest';
import { convexTest } from 'convex-test';
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import schema from '../../convex/schema';
import { api, internal } from '../../convex/_generated/api';

// Deployed intermediate storage contract: old records and new writes coexist.
const transitional = defineSchema({
	...schema.tables,
	players: defineTable({
		...schema.tables.players.validator.fields,
		canHost: v.optional(v.boolean())
	}).index('by_token', ['tokenIdentifier']),
	hostPasses: defineTable({
		codeHash: v.string(),
		note: v.string(),
		createdAt: v.number(),
		expiresAt: v.number(),
		redeemedBy: v.optional(v.id('players')),
		redeemedAt: v.optional(v.number())
	}).index('by_hash', ['codeHash'])
});

describe('hosting data retirement', () => {
	it('cleans multiple pages without changing player identity, revocation or hosting access', async () => {
		const t = convexTest(transitional, import.meta.glob('../../convex/**/*.ts'));
		await t.run(async ({ db }) => {
			for (let i = 0; i < 105; i++) {
				const playerId = await db.insert('players', {
					tokenIdentifier: `issuer|legacy-${i}`,
					displayName: 'Legacy',
					canHost: i % 2 === 0,
					disabled: i === 1,
					createdAt: 123
				});
				await db.insert('hostPasses', {
					codeHash: `hash-${i}`,
					note: 'legacy',
					createdAt: 123,
					expiresAt: 456,
					...(i % 2 === 0 ? { redeemedBy: playerId, redeemedAt: 234 } : {})
				});
			}
		});
		const fresh = t.withIdentity({ tokenIdentifier: 'issuer|fresh' });
		await fresh.mutation(api.players.ensure, { displayName: 'Fresh' });
		for (const phase of ['players', 'passes'] as const) {
			let cursor: string | null = null;
			for (;;) {
				const result: { done: boolean; cursor: string } = await t.mutation(
					internal.ops.retireHostPasses,
					{ phase, cursor }
				);
				if (result.done) break;
				cursor = result.cursor;
			}
			// Restarting is safe after an interruption or a completed run.
			await t.mutation(internal.ops.retireHostPasses, { phase, cursor: null });
		}
		await t.run(async ({ db }) => {
			const players = await db.query('players').collect();
			expect(players).toHaveLength(106);
			expect(players.every((player) => !('canHost' in player))).toBe(true);
			expect(await db.query('hostPasses').collect()).toEqual([]);
		});
		for (const subject of ['legacy-0', 'legacy-2', 'fresh']) {
			const client = t.withIdentity({ tokenIdentifier: `issuer|${subject}` });
			const room = await client.mutation(api.rooms.create, {});
			expect(await client.query(api.rooms.view, { roomId: room.roomId })).toMatchObject({
				status: 'open'
			});
		}
		await expect(
			t.withIdentity({ tokenIdentifier: 'issuer|legacy-1' }).mutation(api.rooms.create, {})
		).rejects.toThrow('DISABLED');
	});
});
