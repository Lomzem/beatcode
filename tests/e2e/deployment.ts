// Public deployment identity, pinned when the dedicated free CI project was
// provisioned. This module is part of the separate test artifact only.
export const CI_BACKEND_URL = 'https://warmhearted-avocet-538.convex.cloud';
export function assertCiDeployment() {
	if (process.env.CONVEX_CLOUD_URL !== CI_BACKEND_URL)
		throw new Error('CI_ARTIFACT_WRONG_DEPLOYMENT');
}
