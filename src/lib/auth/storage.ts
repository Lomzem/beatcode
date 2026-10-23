import { Data, Effect } from 'effect';

// Browser storage is optional. Never retain the exception: it can contain private values.
export class StorageUnavailable extends Data.TaggedError('StorageUnavailable') {}
export const storage = <A>(operation: () => A) =>
	Effect.try({ try: operation, catch: () => new StorageUnavailable() });
export const optionalStorage = <A>(operation: () => A, fallback: A) =>
	storage(operation).pipe(Effect.catchTag('StorageUnavailable', () => Effect.succeed(fallback)));
