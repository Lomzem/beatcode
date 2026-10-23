import { expect, test } from 'vitest';
import { createServerClock } from '../../src/lib/game/clock';

test('a delayed reply preserves the accurate countdown and effect expiry', () => {
	const clock = createServerClock();
	// The server is 500 ms ahead. The first ping takes 20 ms, split evenly.
	clock.observePing(100_000, 100_510, 100_020);
	// The next ping reaches the server in 10 ms, then its reply stalls for six seconds.
	clock.observePing(130_000, 130_510, 136_020);
	expect(clock.now(136_020)).toBe(136_520);
	// An effect ending at server time 135 s has already expired, not three seconds left.
	expect(clock.now(136_020)).toBeGreaterThanOrEqual(135_000);
});

test('the clock follows a new estimate once the old best ping leaves the five-ping window', () => {
	const clock = createServerClock();
	clock.observePing(0, 510, 20);
	// New server offset is 800 ms; four slower pings must retain the older best estimate.
	for (const sentAt of [30_000, 60_000, 90_000, 120_000])
		clock.observePing(sentAt, sentAt + 850, sentAt + 100);
	expect(clock.now(120_100)).toBe(120_600);
	clock.observePing(150_000, 150_850, 150_100);
	expect(clock.now(150_100)).toBe(150_900);
});
