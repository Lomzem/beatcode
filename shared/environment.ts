/** Compiler/runtime identity shared by admission, calibration and the judge. */
export interface JudgeEnvironmentIdentity {
	readonly envId: string;
	readonly modalImageId: string;
	readonly baseDigest: string;
	readonly gccVersion: string;
	readonly runtime: string;
	readonly cpu: number;
	readonly runnerSha256: string;
}

export function serializeEnvironment(environment: JudgeEnvironmentIdentity): string {
	return JSON.stringify([
		environment.envId,
		environment.modalImageId,
		environment.baseDigest,
		environment.gccVersion,
		environment.runtime,
		environment.cpu,
		environment.runnerSha256
	]);
}
