import { Effect } from 'effect';
import { CalibrationFailure } from './game/effect';
import { calibrationDeployment, calibrationAppAllowed } from '../shared/calibrationDeployment';

// Convex 1.48 codegen_templates/server.ts: platform-injected, non-overridable URL.
export function deploymentConfig(requireApp = false) {
	return Effect.suspend(() => {
		const config = calibrationDeployment(
			process.env.CONVEX_CLOUD_URL,
			process.env.CONVEX_DEPLOYMENT
		);
		return !config || (requireApp && !calibrationAppAllowed(config, process.env.MODAL_APP_NAME))
			? Effect.fail(new CalibrationFailure('CALIBRATION_DEPLOYMENT_CONFIG'))
			: Effect.succeed(config);
	});
}
