import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	symlinkSync,
	realpathSync,
	existsSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it('loads the real pinned Node entrypoint and rejects invalid commands silently before authorization', () => {
	const dir = mkdtempSync(join(tmpdir(), 'beatcode-production-cli-'));
	try {
		const result = spawnSync(
			process.execPath,
			[resolve('scripts/problems/production.ts'), '--invalid'],
			{ cwd: dir, env: {}, encoding: 'utf8', timeout: 10000 }
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toBe('');
		expect(result.stdout).toBe('');
		expect(
			JSON.parse(
				readFileSync(
					join(dir, '.scratch/competitive-leetcode/production-calibration/STOP.json'),
					'utf8'
				)
			)
		).toEqual({ outcome: 'PRODUCTION_STOP_REQUIRES_REVIEW' });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it.each(['foreign-checkout', 'copied-entrypoint'] as const)(
	'refuses %s authorization from a different approved checkout before the SDK boundary',
	(kind) => {
		const dir = mkdtempSync(join(tmpdir(), 'beatcode-production-source-'));
		try {
			const approved = join(dir, 'approved');
			// Clone committed current HEAD over local file transport; CI needs no old objects or network.
			const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
			execFileSync('git', [
				'clone',
				'--depth=1',
				'--quiet',
				pathToFileURL(resolve('.')).href,
				approved
			]);
			expect(
				execFileSync('git', ['-C', approved, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
			).toBe(sourceCommit);
			expect(
				execFileSync('git', ['-C', approved, 'rev-parse', '--is-shallow-repository'], {
					encoding: 'utf8'
				}).trim()
			).toBe('true');
			expect(
				execFileSync('git', ['-C', approved, 'rev-list', '--count', 'HEAD'], {
					encoding: 'utf8'
				}).trim()
			).toBe('1');
			symlinkSync(realpathSync(resolve('node_modules')), join(approved, 'node_modules'), 'dir');
			const manifest = join(dir, 'go.json');
			const environment = {
				envId: 'production-fixture',
				modalImageId: 'im-fixture',
				baseDigest: 'sha256:' + 'a'.repeat(64),
				gccVersion: '15.3.0',
				runtime: 'gvisor',
				cpu: 1,
				runnerSha256: '0'.repeat(64)
			};
			writeFileSync(
				manifest,
				JSON.stringify({
					format: 'beatcode-production-calibration/1',
					go: true,
					sourceCommit,
					// Frozen offline release bytes; never derive approval from executing code.
					sourceSha256: 'e9e25a01540832b1a9354f287cccd8cc318ca2866a3717f5fa54977ba5c781f4',
					decisionPolicySha256: 'd4e0591e44e994a16dd9ad19166349132f963dd39a64688b5509acb2e1b072ca',
					executionPolicy: 'staged-input-reference-10s-aggregate-vm-v3',
					maxJobs: 150,
					maxSeconds: 6000,
					environment,
					environmentSha256: createHash('sha256')
						.update(
							JSON.stringify([
								environment.envId,
								environment.modalImageId,
								environment.baseDigest,
								environment.gccVersion,
								environment.runtime,
								environment.cpu,
								environment.runnerSha256
							])
						)
						.digest('hex'),
					productionApp: {
						appName: 'beatcode-calibration-prod-20261023-r1',
						appId: 'ap-1234567890123456789012'
					},
					packages: [
						{
							slug: 'fixture',
							productionBaseline: {
								originDeployment: 'dev:descriptive-scorpion-877',
								originPolicy: 'legacy-fixed-spread-v1',
								originVersionId: 'dev-fixture',
								originVersion: 1,
								publicTimeMs: 700,
								packageSha256: 'a'.repeat(64),
								testsSha256: 'b'.repeat(64),
								referencesSha256: 'c'.repeat(64),
								evidenceSha256: 'd'.repeat(64)
							}
						}
					]
				}),
				{ mode: 0o600 }
			);
			const marker = join(dir, 'sdk-events.jsonl');
			const sdk = join(dir, 'sdk.mjs');
			writeFileSync(
				sdk,
				`import {appendFileSync} from 'node:fs';
const event = value => appendFileSync(${JSON.stringify(marker)}, JSON.stringify(value)+'\\n');
export class ConvexHttpClient {
 constructor(){event('constructor');}
 setAdminAuth(){event('admin-auth');}
 clearAuth(){event('clear-auth');}
 async query(){event('query');return {deployment:'prod:careful-greyhound-596',campaign:'calibration-prod-20261023-v1',maxJobs:150,maxSeconds:6000,executionPolicy:'staged-input-reference-10s-aggregate-vm-v3',pending:0,sharedInFlight:0,jobs:[]};}
}`
			);
			const preload = join(dir, 'preload.mjs');
			writeFileSync(
				preload,
				`import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){return specifier==='convex/browser'?{url:${JSON.stringify(pathToFileURL(sdk).href)},shortCircuit:true}:next(specifier,context);}});`
			);
			const run = (script: string) =>
				spawnSync(process.execPath, ['--import', preload, script, 'preflight', manifest], {
					cwd: approved,
					env: {
						CONVEX_PRODUCTION_DEPLOY_KEY: 'prod:careful-greyhound-596|fixture-not-a-credential'
					},
					encoding: 'utf8',
					timeout: 10000
				});
			const control = run(join(approved, 'scripts/problems/production.ts'));
			expect(control.status).toBe(0);
			expect(control.stderr).toBe('');
			expect(
				readFileSync(marker, 'utf8')
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line))
			).toEqual(['constructor', 'admin-auth', 'query', 'clear-auth']);
			rmSync(marker);
			let script = resolve('scripts/problems/production.ts');
			if (kind === 'copied-entrypoint') {
				const copy = join(approved, 'scripts/problems/unreviewed-production.ts');
				writeFileSync(
					copy,
					readFileSync(script, 'utf8') +
						'\n// Distinct untracked entrypoint bytes are outside the approved release-file hash.\n'
				);
				script = copy;
			}
			const rejected = run(script);
			expect({ status: rejected.status, sdkReached: existsSync(marker) }).toEqual({
				status: 1,
				sdkReached: false
			});
			expect(rejected.stderr).toBe('');
			expect(rejected.stdout).toBe('');
			expect(
				JSON.parse(
					readFileSync(
						join(approved, '.scratch/competitive-leetcode/production-calibration/STOP.json'),
						'utf8'
					)
				)
			).toEqual({ outcome: 'PRODUCTION_STOP_REQUIRES_REVIEW' });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
);
