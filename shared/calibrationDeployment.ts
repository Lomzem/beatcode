// Measurement semantics are unchanged across the two fixed deployment campaigns.
export const EXECUTION_POLICY = 'staged-input-reference-10s-v1';

/** Fixed campaign policy. Deployment identity comes from Convex's built-in cloud URL. */
export const DEV_CALIBRATION = {
	url: 'https://descriptive-scorpion-877.convex.cloud',
	deployment: 'dev:descriptive-scorpion-877',
	campaign: 'calibration-dev-20261023-v1',
	maxJobs: 250,
	maxSeconds: 10000,
	production: false
} as const;
export const PROD_CALIBRATION = {
	url: 'https://careful-greyhound-596.convex.cloud',
	deployment: 'prod:careful-greyhound-596',
	campaign: 'calibration-prod-20261023-v1',
	maxJobs: 150,
	maxSeconds: 6000,
	appName: 'beatcode-calibration-prod-20261023-r1',
	production: true
} as const;
export function calibrationDeployment(url: string | undefined, deployment?: string) {
	const selected =
		url === DEV_CALIBRATION.url
			? DEV_CALIBRATION
			: url === PROD_CALIBRATION.url
				? PROD_CALIBRATION
				: undefined;
	return selected && (!deployment || deployment === selected.deployment) ? selected : undefined;
}
export function calibrationAppAllowed(
	config: NonNullable<ReturnType<typeof calibrationDeployment>>,
	appName: string | undefined
) {
	return config.production
		? appName === PROD_CALIBRATION.appName
		: !!appName?.startsWith('beatcode-calibration-dev-');
}

/** Canonical source identity survives Convex object-key serialization order. */
export function serializeReferences(refs: {
	accepted: string[];
	timeLimitExceeded: string[];
	wrongAnswer: string[];
	validator: string;
}) {
	return JSON.stringify([refs.accepted, refs.timeLimitExceeded, refs.wrongAnswer, refs.validator]);
}
