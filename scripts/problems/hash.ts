import { createHash } from 'node:crypto';

/** Package/operator hashing must run directly in pinned Node without loading backend modules. */
export const sha256 = (bytes: string | Uint8Array) =>
	createHash('sha256').update(bytes).digest('hex');
