import type { FunctionReturnType } from 'convex/server';
import type { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';

// Public SDK view data for each screen state. Shapes follow the production query return types.
type Me = NonNullable<FunctionReturnType<typeof api.players.me>>;
type Room = FunctionReturnType<typeof api.rooms.view>;
type Match = FunctionReturnType<typeof api.matches.view>;
type Round = Match['round'];
export type Fixture =
	| { screen: 'rooms'; me: Me }
	| { screen: 'room'; me: Me; room: Room }
	| { screen: 'match'; me: Me; room: Room; match: Match };

/** The browser clock is fixed here so the server clock, Power and effect timers stay stable. */
export const FIXTURE_NOW = Date.UTC(2026, 9, 27, 12);
const roomId = 'public-room' as Id<'rooms'>;
const matchId = 'public-match' as Id<'matches'>;
const me = { playerId: 'public-player' as Id<'players'>, displayName: 'Ada' };
const opponent = { playerId: 'public-opponent' as Id<'players'>, displayName: 'Grace' };
const seen = { host: FIXTURE_NOW - 5000, guest: FIXTURE_NOW - 8000 };
const deck: Room['ownDeck'] = ['light_mode', 'no_paste', 'brain_teaser', 'strict_compile'];
const room = {
	roomId,
	status: 'lobby',
	ownDeck: deck,
	opponentDeck: null,
	host: me,
	guest: opponent,
	seat: 'host',
	ready: { host: false, guest: true },
	lastSeen: seen,
	currentMatchId: null,
	playerId: me.playerId
} satisfies Room;
const inMatch = {
	...room,
	status: 'in_match',
	opponentDeck: ['no_hints', 'no_paste', 'brain_teaser', 'light_mode'],
	ready: { host: true, guest: true },
	currentMatchId: matchId
} satisfies Room;

function round(index: number, status: Round['status'], startsAt: number): Round {
	return {
		roundId: `public-round-${index}` as Id<'rounds'>,
		index,
		slot: index - 1,
		status,
		startsAt,
		endsAt: startsAt + 600000,
		outcome: null,
		winnerId: null,
		winningSubmissionId: null,
		ownSubmissions: [],
		ownSampleRuns: [],
		opponentPending: status === 'settling' ? null : false,
		opponentVerdicts: [],
		sharedSource: null
	};
}
const firstRoundWon = {
	...round(1, 'finished', FIXTURE_NOW - 700000),
	outcome: 'won',
	winnerId: me.playerId,
	opponentVerdicts: [{ verdict: 'WA', status: 'done' }]
} satisfies Round;
const secondRoundWon = {
	...round(2, 'finished', FIXTURE_NOW - 400000),
	outcome: 'won',
	winnerId: me.playerId,
	opponentVerdicts: [{ verdict: 'TLE', status: 'done' }]
} satisfies Round;
const intermission = round(2, 'intermission', FIXTURE_NOW + 20000);

function match(current: Round, overrides: Partial<Match> = {}): Match {
	return {
		matchId,
		roomId,
		playerId: me.playerId,
		status: 'active',
		wins: { a: 0, b: 0 },
		result: null,
		winnerId: null,
		reason: null,
		round: current,
		rounds: [current],
		players: [
			{ ...me, power: 2, powerTick: 9, usedCards: ['light_mode'] },
			{ ...opponent, power: 4, powerTick: 9, usedCards: ['no_hints'] }
		],
		effects: [],
		ownSubmissions: current.ownSubmissions,
		ownSampleRuns: current.ownSampleRuns,
		opponentPending: current.opponentPending,
		opponentVerdicts: current.opponentVerdicts,
		problem: {
			title: 'Pair sums',
			statementMd:
				'Given n integers and a target t, print the number of index pairs i < j whose values sum to t.',
			samples: [{ input: '4 6\n1 5 3 3\n', output: '2\n' }],
			limits: { timeMs: 1000, memoryMiB: 256, outputKiB: 64, aggregateMs: 10000 }
		},
		...overrides
	};
}
// Round 1 began 95 seconds ago: Power accrues one point every ten seconds from the server value.
const active = round(1, 'active', FIXTURE_NOW - 95000);
const effect = (
	effectId: string,
	cardId: Match['effects'][number]['cardId'],
	toMe: boolean,
	seconds: number
) => ({
	effectId: effectId as Id<'effects'>,
	cardId,
	sourceId: toMe ? opponent.playerId : me.playerId,
	targetId: toMe ? me.playerId : opponent.playerId,
	startsAt: FIXTURE_NOW - 2000,
	endsAt: FIXTURE_NOW + seconds * 1000
});

export const fixtures = {
	rooms: { screen: 'rooms', me },
	'room-open': {
		screen: 'room',
		me,
		room: {
			...room,
			status: 'open',
			ownDeck: [],
			guest: null,
			ready: { host: false, guest: false },
			lastSeen: { host: seen.host }
		}
	},
	'room-lobby': { screen: 'room', me, room },
	'room-results': {
		screen: 'room',
		me,
		room: { ...inMatch, status: 'results', ready: { host: false, guest: false } }
	},
	'room-closed': {
		screen: 'room',
		me,
		room: { ...room, status: 'closed', ready: { host: false, guest: false } }
	},
	'match-active': {
		screen: 'match',
		me,
		room: inMatch,
		match: match(active, { effects: [effect('public-effect-hints', 'no_hints', false, 12)] })
	},
	'match-brain-teaser': {
		screen: 'match',
		me,
		room: inMatch,
		match: match(active, {
			effects: [
				{ ...effect('public-effect-teaser', 'brain_teaser', true, 13), challenge: { a: 17, b: 25 } }
			]
		})
	},
	'match-light-mode': {
		screen: 'match',
		me,
		room: inMatch,
		match: match(active, { effects: [effect('public-effect-light', 'light_mode', true, 18)] })
	},
	'match-settling': {
		screen: 'match',
		me,
		room: inMatch,
		match: match({ ...active, status: 'settling', endsAt: FIXTURE_NOW - 1000 })
	},
	'match-intermission': {
		screen: 'match',
		me,
		room: inMatch,
		match: match(intermission, { wins: { a: 1, b: 0 }, rounds: [firstRoundWon, intermission] })
	},
	'match-finished': {
		screen: 'match',
		me,
		room: { ...inMatch, status: 'results', ready: { host: false, guest: false } },
		match: match(secondRoundWon, {
			status: 'finished',
			wins: { a: 2, b: 0 },
			result: 'win',
			winnerId: me.playerId,
			reason: 'rounds',
			rounds: [firstRoundWon, secondRoundWon]
		})
	}
} satisfies Record<string, Fixture>;
export type FixtureName = keyof typeof fixtures;
export const fixtureNames = Object.keys(fixtures) as FixtureName[];
