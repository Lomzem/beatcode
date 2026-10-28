import { getFunctionName, type FunctionReference } from 'convex/server';
import { selected } from './selected';

// Public SDK view fixtures only. No authentication, backend persistence or judging proof.
// Components read the selected fixture through the SDK query boundary.
const fixture = $state(structuredClone(selected));

window.addEventListener('public-attempts', (event) => {
	if (fixture.screen !== 'match') return;
	const detail = (
		event as CustomEvent<Pick<typeof fixture.match, 'ownSubmissions' | 'ownSampleRuns'>>
	).detail;
	fixture.match.ownSubmissions = detail.ownSubmissions;
	fixture.match.ownSampleRuns = detail.ownSampleRuns;
});

export const useAuth = () => ({ isLoading: false, isAuthenticated: true });
export const useConvexClient = () => ({
	connectionState: () => ({ isWebSocketConnected: true }),
	subscribeToConnectionState: () => () => {},
	// Only the clock ping answers; other mutations resolve without a result.
	mutation: async (reference: FunctionReference<'mutation'>) =>
		getFunctionName(reference) === 'clock:ping' ? { serverNow: Date.now() } : null
});
export function useQuery(reference: FunctionReference<'query'>, args?: () => unknown) {
	const name = getFunctionName(reference);
	return {
		get data() {
			if (args?.() === 'skip') return undefined;
			if (name === 'players:me') return fixture.me;
			if (name === 'rooms:view' && fixture.screen !== 'rooms') return fixture.room;
			if (name === 'matches:view' && fixture.screen === 'match') return fixture.match;
			return null;
		},
		isLoading: false,
		error: undefined
	};
}
