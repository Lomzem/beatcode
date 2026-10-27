import { afterEach, expect, test, vi } from 'vitest';
import { ModalClient } from 'modal';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

vi.mock('modal', () => ({ ModalClient: vi.fn() }));
// Exercise the actual CLI/accounting; isolate its writes from the live operator ledger.
vi.mock('node:fs', async (original) => ({
	...(await original<typeof import('node:fs')>()),
	existsSync: () => false,
	mkdirSync: vi.fn(),
	appendFileSync: vi.fn(),
	writeFileSync: vi.fn()
}));

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

test.each(['cold', 'stalled'] as const)(
	'image inspection bounds transport without publishing an unverified binary: %s',
	async (transport) => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.stubEnv('BEATCODE_ALLOW_IMAGE_BUILD', '1');
		vi.stubEnv('MODAL_APP_NAME', 'beatcode-judge-validation-20261023');
		vi.stubEnv(
			'MODAL_CONFIG_PATH',
			resolve('.scratch/competitive-leetcode/.modal-production.toml')
		);
		vi.stubEnv('MODAL_SANDBOX_V2', '0');
		let dispatch!: () => void;
		const dispatched = new Promise<void>((r) => (dispatch = r));
		let finish!: () => void;
		const pendingDispatch = new Promise<void>((r) => (finish = r));
		const terminated = vi.fn(async () => {});
		const closed = vi.fn();
		const image = { imageId: 'im-' + 'b'.repeat(22) };
		const binaryHash = '7'.repeat(64);
		const stream = (text = '') =>
			new ReadableStream<Uint8Array>({
				start(c) {
					if (text) c.enqueue(Buffer.from(text));
					c.close();
				}
			});
		vi.mocked(ModalClient).mockImplementation(function () {
			return {
				profile: { tokenId: 'fixture', tokenSecret: 'fixture', sandboxV2: false },
				close: closed,
				apps: { fromName: async () => ({ appId: 'ap-fixture' }) },
				images: {
					fromRegistry: () => ({ dockerfileCommands: () => ({ build: async () => image }) })
				},
				sandboxes: {
					async *list() {},
					async create() {
						return {
							sandboxId: 'sb-' + 'a'.repeat(22),
							terminate: terminated,
							async exec() {
								dispatch();
								if (transport === 'cold') await new Promise((r) => setTimeout(r, 8000));
								else await pendingDispatch;
								return {
									stdout: stream(`${binaryHash}  /opt/judge/runner\n`),
									stderr: stream(),
									stdin: new WritableStream(),
									wait: async () => 0
								};
							}
						};
					}
				}
			} as unknown as ModalClient;
		});
		const result = import('../../scripts/judge/build-image').then(
			() => 'verified',
			() => 'failed'
		);
		await dispatched;
		await vi.advanceTimersByTimeAsync(transport === 'cold' ? 8000 : 10000);
		expect(await result).toBe(transport === 'cold' ? 'verified' : 'failed');
		expect(terminated).toHaveBeenCalledOnce();
		expect(closed).toHaveBeenCalledOnce();
		finish(); // A late SDK result must never regain metadata publication authority.
		await vi.advanceTimersByTimeAsync(0);
		const metadata = vi
			.mocked(writeFileSync)
			.mock.calls.filter(([path]) => String(path) === resolve('judge/image.json'));
		expect(metadata).toHaveLength(transport === 'cold' ? 1 : 0);
		if (transport === 'cold')
			expect(JSON.parse(String(metadata[0][1]))).toMatchObject({
				modalImageId: image.imageId,
				runnerSha256: binaryHash
			});
	}
);
