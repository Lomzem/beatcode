import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPackage } from '../../scripts/problems/package';
it('rejects a symlinked hidden input before reading its target', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'beatcode-package-'));
	try {
		mkdirSync(join(dir, 'data/secret'), { recursive: true });
		writeFileSync(join(dir, 'problem.yaml'), '{}');
		writeFileSync(join(dir, 'statement.md'), 'statement');
		symlinkSync('/does-not-exist', join(dir, 'data/secret/01.in'));
		await expect(loadPackage(dir)).rejects.toThrow('PACKAGE_SYMLINK');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
