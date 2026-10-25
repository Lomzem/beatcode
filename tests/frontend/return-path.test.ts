import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { safeReturnPath } from '../../src/lib/auth/return-path';

beforeEach(() => vi.stubGlobal('location', new URL('https://beatcode.org/sign-in')));
afterEach(() => vi.unstubAllGlobals());

test('signed-out visitors can return to play, an invitation, or a room or match link', () => {
	for (const path of [
		'/play',
		'/join#room.token',
		'/room/k57abc_D-9',
		'/match/k57abc_D-9?tab=code#editor'
	])
		expect(safeReturnPath(path)).toBe(path);
});

test('return paths outside the strict allowlist or this origin are refused', () => {
	for (const path of [
		'/room/',
		'/room/a/b',
		'/match/a%2Fb',
		'/room/a.b',
		'/rooms/a',
		'/settings',
		'//evil.example/room/a',
		'https://evil.example/room/a',
		'/room/a\\b',
		'/room/a\nb',
		'room/a'
	])
		expect(safeReturnPath(path)).toBeNull();
});
