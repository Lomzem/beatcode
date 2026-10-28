import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
	Reporter,
	FullConfig,
	FullResult,
	Suite,
	TestCase,
	TestResult
} from '@playwright/test/reporter';

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
// This is the required coverage contract, independent of Playwright's selected suite.
const scenarios = new Map([
	['two authenticated players create, join, ready, preserve code, and concede a match', 'match'],
	['ready commits the displayed saved deck and locks editing until cancelled', 'deck'],
	[
		'a real development account verifies email, persists its nickname, and recovers a private room',
		'account'
	],
	[
		'strict compile reaches a scored verdict and round result through the authenticated UI',
		'verdict'
	]
]);
const projects = ['chromium', 'firefox', 'webkit'].flatMap((browser) =>
	[320, 768, 1280].map((width) => `${browser}-${width}`)
);
const required = new Set(
	projects.flatMap((project) => [...scenarios.values()].map((scenario) => `${project} ${scenario}`))
);
function identity(test: TestCase) {
	const project = test.parent.project()?.name;
	const scenario = scenarios.get(test.title);
	return project && projects.includes(project) && scenario ? `${project} ${scenario}` : undefined;
}
export default class RequiredCoverage implements Reporter {
	private passed = new Set<string>();
	private ended = new Set<string>();
	private invalid = false;
	private failed = 0;
	private started = new Map<string, number>();
	private projectCases = new Map<string, number>();

	onBegin(_config: FullConfig, suite: Suite) {
		const selected = suite.allTests().map(identity);
		this.invalid =
			selected.length !== required.size ||
			new Set(selected).size !== required.size ||
			selected.some((key) => !key || !required.has(key));
	}
	onStdOut(chunk: string | Buffer) {
		process.stdout.write(chunk);
	}
	onTestBegin(test: TestCase) {
		const key = identity(test);
		if (!key) return;
		const project = key.split(' ')[0];
		if (!this.started.has(project)) this.started.set(project, performance.now());
	}
	onTestEnd(test: TestCase, result: TestResult) {
		privateErrors(result.errors);
		const key = identity(test);
		if (!key || this.ended.has(key) || result.retry !== 0) this.invalid = true;
		if (key) this.ended.add(key);
		if (key && result.status === 'passed') this.passed.add(key);
		else this.failed++;
		// Never interpolate an unrecognized project, test title, or error into logs.
		if (!key) return;
		const [project, scenario] = key.split(' ');
		const line = result.errors
			.map((error) => error.stack?.match(/match-authenticated\.spec\.ts:(\d+):/i)?.[1])
			.find(Boolean);
		console.info(`CI case: ${project} ${result.status}${line ? ` line ${line}` : ''}`);
		console.info(`CI timing: ${project} ${scenario} ${Math.round(result.duration)}ms`);
		const count = (this.projectCases.get(project) ?? 0) + 1;
		this.projectCases.set(project, count);
		if (count === scenarios.size && this.started.has(project))
			console.info(
				`CI timing: ${project} project ${Math.round(performance.now() - this.started.get(project)!)}ms`
			);
	}
	onError(error: unknown) {
		this.invalid = true;
		privateErrors([error]);
	}
	async onEnd(result: FullResult): Promise<{ status: 'passed' | 'failed' }> {
		const complete =
			!this.invalid &&
			this.passed.size === required.size &&
			this.failed === 0 &&
			result.status === 'passed';
		console.info(
			`Authenticated coverage: ${this.passed.size} passed, ${this.failed} failed/skipped; required exact 36; ${complete ? 'complete' : 'incomplete'}.`
		);
		return { status: complete ? 'passed' : 'failed' };
	}
}
