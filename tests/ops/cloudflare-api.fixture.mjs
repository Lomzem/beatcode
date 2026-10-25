// Preloaded into the DNS sync CLI subprocess only: requests to the hard-coded
// Cloudflare API origin reach a loopback fixture instead of Cloudflare.
const cloudflare = 'https://api.cloudflare.com';
const fixture = new URL(process.env.CLOUDFLARE_FIXTURE_ORIGIN ?? '').origin;
const send = globalThis.fetch;

/** @param {RequestInfo | URL} input @param {RequestInit} [init] */
globalThis.fetch = (input, init) => {
	const url = new URL(input instanceof Request ? input.url : input);
	if (url.origin !== cloudflare) throw new TypeError('Fixture permits only the Cloudflare API.');
	return send(fixture + url.pathname + url.search, init);
};
