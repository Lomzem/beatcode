// Framework URL resolution is outside this component regression.
export const resolve = (path: string, params?: { id: string }) =>
	path.replace('[id]', params?.id ?? '');
