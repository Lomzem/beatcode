// Preloaded into the smoke CLI subprocess only: requests to the hard-coded
// production origin reach a loopback fixture, and responses report the
// production origin back, so real HTTP redirect handling still applies.
const production = 'https://beatcode.org';
const fixture = new URL(process.env.SMOKE_FIXTURE_ORIGIN ?? '').origin;
const send = globalThis.fetch;

/** @param {RequestInfo | URL} input @param {RequestInit} [init] */
globalThis.fetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : input);
	if (url.origin !== production) throw new TypeError('Fixture permits only the production origin.');
	const response = await send(fixture + url.pathname + url.search, init);
	const served = new URL(response.url);
	Object.defineProperty(response, 'url', {
		value: served.origin === fixture ? production + served.pathname + served.search : served.href
	});
	return response;
};
