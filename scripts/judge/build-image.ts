// Trusted image build only. GCC executes in Modal, never on the workstation.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Effect } from 'effect';
import { BASE_DIGEST, sha256, readBoundedEffect } from '../../judge/controller.ts';
import { modalClient } from '../../judge/modal.ts';
import { reserve, record, reaper, validationApp } from './validation-budget.ts';
import { OperatorError, operatorAsync, operatorSync } from '../problems/effects.ts';

const build = Effect.scoped(
	Effect.gen(function* () {
		if (process.env.BEATCODE_ALLOW_IMAGE_BUILD !== '1')
			return yield* new OperatorError({
				message: 'Set BEATCODE_ALLOW_IMAGE_BUILD=1 for a reviewed cloud build'
			});
		const name = yield* operatorSync('VALIDATION_CONFIG', validationApp);
		const source = yield* operatorSync('RUNNER_SOURCE_READ', () =>
			readFileSync(resolve('judge/runner.c'))
		);
		const client = yield* Effect.acquireRelease(
			operatorSync('MODAL_CONFIG', modalClient),
			(client) => operatorSync('MODAL_CLOSE', () => client.close()).pipe(Effect.orDie)
		);
		const app = yield* operatorAsync('VALIDATION_APP', () =>
			client.apps.fromName(name, { createIfMissing: true })
		);
		yield* operatorSync('VALIDATION_BUDGET', () => reserve('image-build', 60, true));
		const image = yield* operatorAsync('IMAGE_BUILD', () =>
			client.images
				.fromRegistry(`gcc:15.3.0@${BASE_DIGEST}`)
				.dockerfileCommands([
					'RUN mkdir -p /opt/judge /work/sub /work/bin && chown 65534:65534 /work/sub && chmod 0700 /work/sub && chmod 0755 /work /work/bin && chmod 0700 /var/tmp',
					`RUN echo ${source.toString('base64')} | base64 -d > /opt/judge/runner.c && timeout -s KILL 40 gcc -O2 -Wall -Wextra -Werror -static -o /opt/judge/runner /opt/judge/runner.c && rm /opt/judge/runner.c && chmod 0755 /opt/judge/runner && sha256sum /opt/judge/runner > /opt/judge/runner.sha256`,
					'RUN g++ --version | head -1 > /opt/judge/gcc-version'
				])
				.build(app)
		).pipe(
			Effect.timeoutOrElse({
				duration: 60000,
				orElse: () =>
					Effect.gen(function* () {
						yield* operatorAsync('IMAGE_BUILD_STOP_FAILED', () =>
							client.cpClient.appStop({ appId: app.appId, source: 0 })
						);
						return yield* new OperatorError({ message: 'IMAGE_BUILD_CUTOFF' });
					})
			})
		);
		yield* operatorSync('VALIDATION_BUDGET', () => reserve('image-inspection'));
		const sandbox = yield* Effect.acquireRelease(
			operatorAsync('IMAGE_INSPECTION_CREATE', () =>
				client.sandboxes.create(app, image, {
					runtime: 'gvisor',
					cpu: 1,
					cpuLimit: 1,
					memoryMiB: 768,
					memoryLimitMiB: 768,
					timeoutMs: 40000,
					idleTimeoutMs: 20000,
					blockNetwork: true,
					command: ['sleep', '60'],
					tags: { app: 'beatcode-image-build' }
				})
			),
			(sandbox) =>
				operatorAsync('IMAGE_INSPECTION_TERMINATE', () => sandbox.terminate()).pipe(
					Effect.ensuring(
						operatorAsync('IMAGE_CLEANUP', () => reaper(client, 'image')).pipe(Effect.orDie)
					),
					Effect.orDie
				)
		);
		yield* operatorSync('VALIDATION_LEDGER_WRITE', () =>
			record({ event: 'created', label: 'image-inspection', id: sandbox.sandboxId })
		);
		if (!/^sb-[0-9A-Za-z]{22}$/.test(sandbox.sandboxId))
			return yield* new OperatorError({ message: 'Backend mismatch' });
		const text = yield* Effect.gen(function* () {
			const process = yield* operatorAsync('IMAGE_INSPECTION', () =>
				sandbox.exec(['/usr/bin/sha256sum', '/opt/judge/runner'], {
					mode: 'binary',
					timeoutMs: 3000
				})
			);
			const [out, , code] = yield* Effect.all(
				[
					readBoundedEffect(process.stdout, 256),
					readBoundedEffect(process.stderr, 1024),
					operatorAsync('IMAGE_INSPECTION', () => process.wait()),
					operatorAsync('IMAGE_INSPECTION', () => process.stdin.close())
				],
				{ concurrency: 'unbounded' }
			);
			if (code !== 0) return yield* new OperatorError({ message: 'IMAGE_INSPECTION' });
			return out.toString();
		}).pipe(
			Effect.timeoutOrElse({
				duration: 3000,
				orElse: () => Effect.fail(new OperatorError({ message: 'IMAGE_INSPECTION_TIMEOUT' }))
			})
		);
		if (!/^[a-f0-9]{64} {2}\/opt\/judge\/runner\n$/.test(text))
			return yield* new OperatorError({ message: 'Invalid runner digest' });
		const metadata = {
			modalImageId: image.imageId,
			baseDigest: BASE_DIGEST,
			gccVersion: '15.3.0',
			runtime: 'gvisor',
			cpu: 1,
			runnerSha256: text.slice(0, 64),
			runnerSourceSha256: sha256(source)
		};
		yield* operatorSync('IMAGE_METADATA_WRITE', () =>
			writeFileSync(
				resolve(process.argv[2] ?? 'judge/image.json'),
				JSON.stringify(metadata, null, 2) + '\n'
			)
		);
	})
);

await Effect.runPromise(build);
