/**
 * Preloaded with `node --require` into a CLI process under test. Every fetch
 * to IMS or the DGR API goes to the loopback stand-in on DGR_TEST_STUB_PORT
 * instead, with the original host name kept as the first path segment; a
 * fetch to any other host is refused, so the process never reaches a network.
 */
const port = process.env.DGR_TEST_STUB_PORT;
const ROUTED = new Set(['ims-na1.adobelogin.com', 'audio-video-api.adobe.io']);
const realFetch = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw);
  if (!ROUTED.has(url.hostname)) {
    return Promise.reject(new TypeError(`loopback-fetch: no route to ${url.hostname}`));
  }
  return realFetch(`http://127.0.0.1:${port}/${url.hostname}${url.pathname}${url.search}`, init);
};
