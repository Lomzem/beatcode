import { defineConfig } from 'vitest/config';
export default defineConfig({
	test: {
		include: ['tests/backend/**/*.test.ts', 'tests/judge/**/*.test.ts', 'tests/ops/**/*.test.ts'],
		environment: 'node'
	}
});
