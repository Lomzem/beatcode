import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Reporter, FullResult, TestCase, TestResult } from '@playwright/test/reporter';

// A successful process must mean every selected authenticated case actually ran.
// Do not print errors/attachments: browser diagnostics can contain session data.
function privateErrors(errors: unknown[]) {
	const directory = process.env.MATCH_E2E_DIAGNOSTICS_DIR;
	if (!directory || !errors.length) return;
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	appendFileSync(join(directory, 'errors.private.jsonl'), JSON.stringify(errors) + '\n', {
		mode: 0o600
	});
}
export default class RequiredCoverage implements Reporter {
	private passed = 0;
	private failed = 0;
	onStdOut(chunk: string | Buffer) {
		process.stdout.write(chunk);
	}
	onTestEnd(test: TestCase, result: TestResult) {
		privateErrors(result.errors);
		if (result.status === 'passed') this.passed++;
		else this.failed++;
		const line = result.errors
			.map((error) => error.stack?.match(/match-authenticated\.spec\.ts:(\d+):/i)?.[1])
			.find(Boolean);
		console.info(
			`CI case: ${test.parent.project()?.name} ${result.status}${line ? ` line ${line}` : ''}`
		);
	}
	onError(error: unknown) {
		privateErrors([error]);
	}
	async onEnd(result: FullResult): Promise<{ status: 'passed' | 'failed' }> {
		const complete = this.passed >= 36 && this.failed === 0 && result.status === 'passed';
		console.info(
			`Authenticated coverage: ${this.passed} passed, ${this.failed} failed/skipped; required minimum 36.`
		);
		return { status: complete ? 'passed' : 'failed' };
	}
}
