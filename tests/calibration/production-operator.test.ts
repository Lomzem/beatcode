import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { ALL_HISTORY_POLICY_SPEC } from '../../convex/game/validators';
import { serializeEnvironment } from '../../shared/environment';
import { serializeReferences } from '../../shared/calibrationDeployment';

// Remote SDK protocol fixtures test CLI admission/dispatch only; they make no DB/native claims.
const sdk = vi.hoisted(() => ({
	calls: [] as { name: string; args: Record<string, unknown> }[],
	closed: 0,
	sourceMismatch: false,
	fail: false,
	oldError: false,
	stop: false,
	manifest: ''
}));
vi.mock('node:child_process', () => ({
	execFileSync: vi.fn((_file: string, args: string[]) =>
		args.includes('--show-toplevel') ? process.cwd() : '6fc2ee786aad0e36eb614271de143eaa92b3c287\n'
	)
}));
vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>();
	return {
		...actual,
		readFileSync: vi.fn((path: string) =>
			path === '/private/go.json'
				? sdk.manifest
				: path.endsWith('.ts')
					? 'reviewed source'
					: actual.readFileSync(path)
		),
		lstatSync: vi.fn(() => ({
			mode: 0o100600,
			size: 1000,
			isFile: () => true,
			isSymbolicLink: () => false
		})),
		existsSync: vi.fn((path: string) => (path.endsWith('STOP.json') ? sdk.stop : true)),
		mkdirSync: vi.fn(),
		writeFileSync: vi.fn((path: string) => {
			if (path.endsWith('STOP.json')) sdk.stop = true;
		})
	};
});
vi.mock('convex/browser', () => ({
	ConvexHttpClient: class {
		constructor(url: string, options: { logger: boolean }) {
			expect(url).toBe('https://careful-greyhound-596.convex.cloud');
			expect(options.logger).toBe(false);
		}
		setAdminAuth(key: string) {
			expect(key).toBe('prod:careful-greyhound-596|fixture-not-a-credential');
		}
		clearAuth() {
			sdk.closed++;
		}
		async query(ref: Parameters<typeof getFunctionName>[0], args: Record<string, unknown>) {
			const name = getFunctionName(ref);
			sdk.calls.push({ name, args });
			if (sdk.fail) throw new Error('PRIVATE_SOURCE_TOKEN');
			if (name === 'calibrationState:_status')
				return {
					deployment: 'prod:careful-greyhound-596',
					campaign: 'calibration-prod-20261023-v1',
					maxJobs: 150,
					maxSeconds: 6000,
					executionPolicy: 'staged-input-reference-10s-aggregate-vm-v3',
					pending: 0,
					sharedInFlight: 0,
					jobs: sdk.oldError
						? [
								{
									problemVersionId: 'version',
									role: 'accepted',
									index: 0,
									repeat: 0,
									released: true,
									creation: 'stopped',
									executionPolicy: 'staged-input-reference-10s-aggregate-vm-v3',
									deployment: 'prod:careful-greyhound-596',
									appId: 'ap-1234567890123456789012',
									result: { verdict: 'ERROR' }
								}
							]
						: []
				};
			if (name === 'problems:_calibrationInput')
				return {
					version: {
						packageSha256: baseline.packageSha256,
						productionBaseline: Object.fromEntries(Object.entries(baseline).reverse()),
						referenceSolutions: refs
					},
					environment: { ...environment, productionApp: app }
				};
			throw new Error('unexpected query');
		}
		async mutation(ref: Parameters<typeof getFunctionName>[0], args: Record<string, unknown>) {
			sdk.calls.push({ name: getFunctionName(ref), args });
			return { judgeEnvId: 'environment' };
		}
		async action(ref: Parameters<typeof getFunctionName>[0], args: Record<string, unknown>) {
			const name = getFunctionName(ref);
			sdk.calls.push({ name, args });
			if (name === 'calibration:_finalizeProduction')
				return { activated: true, evidenceSha256: 'e'.repeat(64) };
			return {
				verdict:
					args.role === 'wrongAnswer' ? 'WA' : args.role === 'timeLimitExceeded' ? 'TLE' : 'AC'
			};
		}
	}
}));
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const refs = {
	accepted: ['int main(){}'],
	timeLimitExceeded: ['int main(){}'],
	wrongAnswer: ['int main(){}'],
	validator: 'int main(){}'
};
const environment = {
	envId: 'production-fixture',
	modalImageId: 'im-fixture',
	baseDigest: 'sha256:' + 'a'.repeat(64),
	gccVersion: '15.3.0',
	runtime: 'gvisor',
	cpu: 1,
	runnerSha256: '0'.repeat(64)
};
const app = {
	appName: 'beatcode-calibration-prod-20261023-r1',
	appId: 'ap-1234567890123456789012'
};
const baseline = {
	originDeployment: 'dev:descriptive-scorpion-877',
	originPolicy: 'alpha-complexity-all-history-v1',
	originVersionId: 'dev-version',
	originVersion: 1,
	publicTimeMs: 700,
	packageSha256: 'a'.repeat(64),
	testsSha256: 'b'.repeat(64),
	referencesSha256: hash(serializeReferences(refs)),
	decisionPolicySha256: hash(ALL_HISTORY_POLICY_SPEC),
	evidenceSha256: 'c'.repeat(64)
};
const manifest = () => ({
	format: 'beatcode-production-calibration/1',
	go: true,
	sourceCommit: '6fc2ee786aad0e36eb614271de143eaa92b3c287',
	// Independently frozen digest of the release boundary with each file containing "reviewed source".
	sourceSha256: '98a9ee0027b196d374541034909117e13b0476123b9751101086f065e2144832',
	decisionPolicySha256: hash(ALL_HISTORY_POLICY_SPEC),
	executionPolicy: 'staged-input-reference-10s-aggregate-vm-v3',
	maxJobs: 150,
	maxSeconds: 6000,
	environment,
	environmentSha256: hash(serializeEnvironment(environment)),
	productionApp: app,
	packages: [{ slug: 'fixture', productionBaseline: { ...baseline } }]
});
let argv: string[];
beforeEach(() => {
	argv = process.argv;
	process.exitCode = 0;
	sdk.calls = [];
	sdk.closed = 0;
	sdk.fail = false;
	sdk.oldError = false;
	sdk.stop = false;
	sdk.manifest = JSON.stringify(manifest());
	vi.stubEnv('CONVEX_PRODUCTION_DEPLOY_KEY', 'prod:careful-greyhound-596|fixture-not-a-credential');
	for (const name of [
		'CONVEX_DEPLOY_KEY',
		'CONVEX_DEPLOYMENT_TOKEN',
		'CONVEX_DEPLOYMENT',
		'PUBLIC_CONVEX_URL',
		'CONVEX_CLOUD_URL',
		'CONVEX_SELF_HOSTED_URL',
		'CONVEX_SELF_HOSTED_ADMIN_KEY'
	])
		vi.stubEnv(name, '');
});
afterEach(() => {
	process.argv = argv;
	process.exitCode = 0;
	vi.unstubAllEnvs();
});
async function run(command = 'preflight', subject?: string) {
	vi.resetModules();
	process.argv = [
		'node',
		'production.ts',
		command,
		'/private/go.json',
		...(subject ? [subject] : [])
	];
	await import('../../scripts/problems/production');
}
it.each(['wrong-key', 'conflicting-url', 'wrong-source', 'stop', 'unknown-command'])(
	'blocks %s before SDK dispatch',
	async (failure) => {
		if (failure === 'wrong-key')
			vi.stubEnv('CONVEX_PRODUCTION_DEPLOY_KEY', 'dev:descriptive-scorpion-877|fixture');
		if (failure === 'conflicting-url')
			vi.stubEnv('PUBLIC_CONVEX_URL', 'https://warmhearted-avocet-538.convex.cloud');
		if (failure === 'wrong-source')
			sdk.manifest = JSON.stringify({ ...manifest(), sourceSha256: 'f'.repeat(64) });
		if (failure === 'stop') sdk.stop = true;
		await run(failure === 'unknown-command' ? '--push' : 'preflight');
		expect(process.exitCode).toBe(1);
		expect(sdk.calls).toEqual([]);
		expect(sdk.stop).toBe(true);
	}
);
it('preflights with the fixed official HTTP admin transport and clears in-process authorization', async () => {
	await run();
	expect(process.exitCode).toBe(0);
	expect(sdk.calls.map((c) => c.name)).toEqual(['calibrationState:_status']);
	expect(sdk.closed).toBe(1);
});
it('dispatches exactly two validators, slow sample, eight AC, eight slow, WA and named production finalization', async () => {
	await run('calibrate', 'version');
	expect(process.exitCode).toBe(0);
	const actions = sdk.calls.filter((c) => c.name.startsWith('calibration:'));
	expect(actions.map((c) => c.args.role ?? c.name)).toEqual([
		'validator',
		'validator',
		'slowSample',
		...Array(8).fill('accepted'),
		...Array(8).fill('timeLimitExceeded'),
		'wrongAnswer',
		'calibration:_finalizeProduction'
	]);
	expect(sdk.closed).toBe(1);
});
it.each([true, false])(
	'stops without native dispatch or automatic retry on old ERROR=%s or SDK failure',
	async (oldError) => {
		sdk.oldError = oldError;
		sdk.fail = !oldError;
		await run('calibrate', 'version');
		expect(process.exitCode).toBe(1);
		expect(sdk.calls.filter((c) => c.name.startsWith('calibration:'))).toEqual([]);
		expect(sdk.stop).toBe(true);
		expect(sdk.closed).toBe(1);
	}
);

it.each([
	'legacy-absent',
	'legacy-null',
	'named-missing',
	'named-wrong',
	'legacy-fabricated'
] as const)('honors actual origin policy provenance: %s', async (origin) => {
	const m = manifest();
	const b = m.packages[0].productionBaseline as Record<string, unknown>;
	if (origin.startsWith('legacy')) b.originPolicy = 'legacy-fixed-spread-v1';
	if (origin === 'legacy-absent' || origin === 'named-missing') delete b.decisionPolicySha256;
	if (origin === 'legacy-null') b.decisionPolicySha256 = null;
	if (origin === 'named-wrong') b.decisionPolicySha256 = 'f'.repeat(64);
	sdk.manifest = JSON.stringify(m);
	await run();
	const valid = origin === 'legacy-absent' || origin === 'legacy-null';
	expect(process.exitCode).toBe(valid ? 0 : 1);
	expect(sdk.calls.map((c) => c.name)).toEqual(valid ? ['calibrationState:_status'] : []);
});
