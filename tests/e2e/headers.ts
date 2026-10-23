import { readFile, writeFile } from 'node:fs/promises';
import { Effect } from 'effect';
export default function ciHeaders() {
	return Effect.tryPromise({
		try: async () => {
			const headers = await readFile('build/_headers', 'utf8');
			await writeFile(
				'build/_headers',
				headers.replaceAll('https://clerk.beatcode.org', process.env.CLERK_JWT_ISSUER_DOMAIN!)
			);
		},
		catch: () => new Error('CI development headers failed')
	});
}
