import { getFunctionName, type FunctionReference } from 'convex/server';

// Public SDK view fixtures only. No authentication, backend persistence or judging proof.
const match = $state({
	playerId: 'public-player',
	roomId: 'public-room',
	status: 'active',
	players: [
		{ playerId: 'public-player', displayName: 'Player', power: 0, powerTick: 0, usedCards: [] },
		{ playerId: 'public-opponent', displayName: 'Opponent', power: 0, powerTick: 0, usedCards: [] }
	],
	wins: { a: 0, b: 0 },
	round: { roundId: 'public-round', index: 1, status: 'active', startsAt: 0, endsAt: 600000 },
	effects: [],
	ownSubmissions: [] as { receivedAt: number; diagnostics?: string; seq: number; status: string }[],
	ownSampleRuns: [] as {
		createdAt: number;
		diagnostics?: string | null;
		status: string;
		verdict?: string | null;
		sampleRunId?: string;
		results?: { verdict: string; output: string }[];
	}[],
	rounds: [],
	opponentPending: false
});

window.addEventListener('public-attempts', (event) => {
	const detail = (event as CustomEvent<Pick<typeof match, 'ownSubmissions' | 'ownSampleRuns'>>)
		.detail;
	match.ownSubmissions = detail.ownSubmissions;
	match.ownSampleRuns = detail.ownSampleRuns;
});

export const useAuth = () => ({ isAuthenticated: false });
export const useConvexClient = () => ({
	connectionState: () => ({ isWebSocketConnected: true }),
	subscribeToConnectionState: () => () => {},
	mutation: async () => null
});
export function useQuery(reference: FunctionReference<'query'>) {
	const name = getFunctionName(reference);
	return {
		get data() {
			if (name === 'matches:view') return match;
			if (name === 'rooms:view')
				return { seat: 'host', ownDeck: [], lastSeen: { host: 0, guest: 0 } };
			return null;
		},
		error: null
	};
}
