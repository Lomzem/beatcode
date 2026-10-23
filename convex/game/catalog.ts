import { PROD_CALIBRATION } from '../../shared/calibrationDeployment';
import type { BackendFailure } from './effect';
import { Effect } from 'effect';
import { reject, step } from './effect';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
export function activeCatalog(
	ctx: MutationCtx
): Effect.Effect<(Doc<'problems'> & { versionId: Id<'problemVersions'> })[], BackendFailure> {
	return Effect.gen(function* () {
		const problems = (yield* step(ctx.db.query('problems').collect())).filter(
			(p) => !p.retired && p.activeVersionId
		);
		const active: (Doc<'problems'> & { versionId: Id<'problemVersions'> })[] = [];
		for (const p of problems) {
			const version = yield* step(ctx.db.get(p.activeVersionId!));
			const environment = version ? yield* step(ctx.db.get(version.judgeEnvId)) : null;
			if (
				version?.status === 'active' &&
				environment?.status === 'active' &&
				(process.env.CONVEX_CLOUD_URL !== PROD_CALIBRATION.url ||
					(version.productionBaseline && version.productionDecision?.outcome === 'PASSED'))
			)
				active.push({ ...p, versionId: version._id });
		}
		if ([1, 2, 3].some((d) => active.filter((p) => p.difficulty === d).length < 2))
			return yield* reject('BAD_STATE', 'Active calibrated problem pool is incomplete');
		return active;
	});
}
