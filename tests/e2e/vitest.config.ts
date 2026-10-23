import { defineConfig } from 'vitest/config';
export default defineConfig({
	test: {
		include: [
			'tests/e2e/artifact.test.ts',
			'tests/e2e/card-diagnostics.test.ts',
			'tests/e2e/process.test.ts',
			'tests/e2e/clerk-resources.test.ts'
		],
		environment: 'node'
	}
});
