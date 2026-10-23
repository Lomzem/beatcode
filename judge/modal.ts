import { ModalClient } from 'modal';
import { Effect } from 'effect';
import { isAbsolute } from 'node:path';
import type { SandboxProvider } from './controller.ts';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
export function modalClient() {
	// Assert the pin rather than silently using a different network/runtime backend.
	if (process.env.MODAL_SANDBOX_V2 !== '0') throw new Error('MODAL_CONFIG');
	const fileConfig = process.env.MODAL_CONFIG_PATH;
	if (fileConfig && !isAbsolute(fileConfig)) throw new Error('MODAL_CONFIG_PATH');
	const client = new ModalClient({
		tokenId: process.env.MODAL_TOKEN_ID,
		tokenSecret: process.env.MODAL_TOKEN_SECRET,
		logger: silent,
		logLevel: 'error'
	});
	const invalid =
		!client.profile.tokenId || !client.profile.tokenSecret
			? 'MODAL_CONFIG'
			: client.profile.sandboxV2 !== false
				? 'MODAL_BACKEND'
				: undefined;
	if (invalid) {
		// Caller scopes cannot release a client that the factory never returns.
		Effect.runSync(
			Effect.try({
				try: () => client.close(),
				catch: () => new Error('MODAL_TRANSPORT')
			})
		);
		throw new Error(invalid);
	}
	return client;
}
// Keep credentials and provider diagnostics out of rejected public Promises.
const modalOperation = <A>(operation: () => PromiseLike<A>) =>
	Effect.tryPromise({ try: operation, catch: () => new Error('MODAL_TRANSPORT') });

export function modalProvider(client: ModalClient, appName: string): SandboxProvider {
	return {
		create: (imageId, config) =>
			Effect.runPromise(
				Effect.gen(function* () {
					const app = yield* modalOperation(() => client.apps.fromName(appName));
					const image = yield* modalOperation(() => client.images.fromId(imageId));
					// Ownership transfers to the controller's sandbox scope when this resolves.
					const sb = yield* modalOperation(() =>
						client.sandboxes.create(app, image, {
							...config,
							tags: { ...config.tags, createdAtMs: String(Date.now()) }
						})
					);
					return {
						id: sb.sandboxId,
						terminate: () =>
							Effect.runPromise(
								Effect.gen(function* () {
									yield* modalOperation(() => sb.terminate());
									const deadline = Date.now() + 2000;
									while ((yield* modalOperation(() => sb.poll())) === null) {
										if (Date.now() >= deadline)
											return yield* Effect.fail(new Error('TERMINATION_PENDING'));
										yield* Effect.sleep(100);
									}
								})
							),
						exec: (argv: string[], timeoutMs: number) =>
							Effect.runPromise(
								modalOperation(() =>
									sb.exec(argv, { mode: 'binary', stdout: 'pipe', stderr: 'pipe', timeoutMs })
								)
							)
					};
				})
			)
	};
}
