/** Estimates server time using the lowest RTT of the last five successful pings.
 * All timestamps are Unix milliseconds; a new clock starts at local time.
 */
export function createServerClock() {
	let offset = 0;
	const samples: { rtt: number; offset: number }[] = [];
	return {
		observePing(sentAt: number, serverNow: number, receivedAt: number) {
			samples.push({ rtt: receivedAt - sentAt, offset: serverNow - (sentAt + receivedAt) / 2 });
			if (samples.length > 5) samples.shift();
			offset = samples.reduce((best, sample) => (sample.rtt <= best.rtt ? sample : best)).offset;
		},
		now(localNow: number) {
			return localNow + offset;
		}
	};
}
