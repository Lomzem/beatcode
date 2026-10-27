import { afterEach, expect, it, vi } from 'vitest';
import { ModalClient } from 'modal';
import { modalClient } from '../../judge/modal';

vi.mock('modal', () => ({ ModalClient: vi.fn() }));
afterEach(() => vi.unstubAllEnvs());

it.each(['missing credentials', 'wrong backend'])(
	'closes an allocated SDK client rejected for %s',
	(reason) => {
		vi.stubEnv('MODAL_SANDBOX_V2', '0');
		vi.stubEnv('MODAL_CONFIG_PATH', '');
		const close = vi.fn();
		const profile =
			reason === 'missing credentials'
				? { sandboxV2: false }
				: { tokenId: 'private-fixture', tokenSecret: 'private-fixture', sandboxV2: true };
		vi.mocked(ModalClient).mockImplementation(function () {
			return { profile, close } as unknown as ModalClient;
		});
		expect(() => modalClient()).toThrow(
			reason === 'missing credentials' ? 'MODAL_CONFIG' : 'MODAL_BACKEND'
		);
		expect(close).toHaveBeenCalledOnce();
	}
);
