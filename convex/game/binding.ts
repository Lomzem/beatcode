import { serializeEnvironment } from '../../shared/environment';
import type { BackendFailure } from './effect';
import { Effect } from 'effect';
import { step } from './effect';
import type { Doc } from '../_generated/dataModel';
export function sha256(text: string): Effect.Effect<string, BackendFailure> {
	return Effect.gen(function* () {
		const digest = yield* step(crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
		return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
	});
}
export function admissionSnapshot(
	profile: 'std' | 'strict',
	source: string,
	problem: Doc<'problemVersions'>,
	environment: Doc<'judgeEnvironments'>
): Effect.Effect<Doc<'submissions'>['snapshot'], BackendFailure> {
	return Effect.gen(function* () {
		return {
			profile,
			problemVersionId: problem._id,
			judgeEnvId: environment._id,
			sourceSha256: yield* sha256(source),
			testsSha256: problem.testsSha256,
			environmentSha256: yield* sha256(serializeEnvironment(environment))
		};
	});
}
