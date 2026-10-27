import { Effect } from 'effect';
import { step } from './effect';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
export function roundView(
	ctx: QueryCtx,
	round: Doc<'rounds'>,
	match: Doc<'matches'>,
	playerId: Id<'players'>
) {
	return Effect.gen(function* () {
		const submissions = yield* step(
			ctx.db
				.query('submissions')
				.withIndex('by_round_seq', (q) => q.eq('roundId', round._id))
				.collect()
		);
		const ownSubmissions = submissions
			.filter((s) => s.playerId === playerId)
			.map((s) => {
				const withheld = round.status === 'settling' && s.verdict === 'AC';
				return {
					submissionId: s._id,
					seq: s.seq,
					receivedAt: s.receivedAt,
					source: s.source ?? null,
					purgedAt: s.purgedAt ?? null,
					profile: s.snapshot.profile,
					status: withheld ? 'pending' : s.status,
					verdict: withheld ? null : s.verdict === 'OLE' ? 'WA' : (s.verdict ?? null),
					sandboxTerminated: !withheld && (s.sandboxTerminated ?? false),
					...(s.phase === 'sample' && !withheld && s.sampleFeedback
						? { sampleFeedback: s.sampleFeedback }
						: {}),
					...(s.diagnostics && s.verdict === 'CE' ? { diagnostics: s.diagnostics } : {})
				};
			});
		const opponentPending =
			round.status === 'settling'
				? null
				: submissions.some((s) => s.playerId !== playerId && s.status === 'pending');
		const opponentVerdicts =
			round.status === 'finished'
				? submissions
						.filter((s) => s.playerId !== playerId)
						.map((s) => ({
							verdict: s.verdict === 'OLE' ? 'WA' : (s.verdict ?? null),
							status: s.status
						}))
				: [];
		const ownSampleRuns = (yield* step(
			ctx.db
				.query('sampleRuns')
				.withIndex('by_round_player', (q) => q.eq('roundId', round._id).eq('playerId', playerId))
				.collect()
		)).map((s) => ({
			sampleRunId: s._id,
			verdict: s.verdict === 'OLE' ? 'WA' : (s.verdict ?? null),
			purgedAt: s.purgedAt ?? null,
			status: s.status,
			createdAt: s.createdAt,
			results:
				s.results?.map((r) => ({
					verdict: r.verdict === 'OLE' ? 'WA' : r.verdict,
					output: r.output
				})) ?? null,
			diagnostics: s.diagnostics ?? null
		}));
		const opponentId = match.playerIds.find((id) => id !== playerId)!;
		const sourceShared =
			match.status === 'finished' &&
			match.sharedSource[match.playerIds[0] === opponentId ? 'a' : 'b'];
		const sharedSource = sourceShared
			? (submissions.filter((s) => s.playerId === opponentId).at(-1)?.source ?? null)
			: null;
		return {
			roundId: round._id,
			index: round.index,
			slot: round.slot,
			status: round.status,
			startsAt: round.startsAt,
			endsAt: round.endsAt,
			outcome: round.outcome ?? null,
			winnerId: round.winnerId ?? null,
			winningSubmissionId: round.winningSubmissionId ?? null,
			ownSubmissions,
			ownSampleRuns,
			opponentPending,
			opponentVerdicts,
			sharedSource
		};
	});
}
