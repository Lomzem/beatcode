import { defineConfig } from 'vitest/config';
export default defineConfig({
	test: { include: ['tests/calibration/**/*.test.ts'], environment: 'node' }
});
