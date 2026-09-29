import { getEventListeners } from 'node:events';
import { inspect } from 'node:util';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { GetAccessTokenOptions, TokenProvider } from '../src/core/auth.js';
import { AudioVideoError } from '../src/core/errors.js';
import { DEFAULT_HOST, HttpClient } from '../src/core/http.js';
import { deferred } from './support/fake-ims.js';
import { flush, until } from './support/mock-api.js';

const originalDispatcher = getGlobalDispatcher();
let agent: MockAgent;

const getAccessTokenMock = vi.fn<(opts?: GetAccessTokenOptions) => Promise<string>>();
const tokenProvider: TokenProvider = { getAccessToken: getAccessTokenMock };

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  getAccessTokenMock.mockReset().mockResolvedValue('TOKEN_1');
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await agent.close();
  setGlobalDispatcher(originalDispatcher);
});

function pool(host = DEFAULT_HOST) {
  return agent.get(host);
}

/** The {@link AudioVideoError} a request rejects with; fails the test if it resolves or rejects with anything else. */
async function rejection(request: Promise<unknown>): Promise<AudioVideoError> {
  const outcome: unknown = await request.then(
    () => 'resolved',
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(AudioVideoError);
  return outcome as AudioVideoError;
}

// --- success + header injection ------------------------------------------------

test('injects Authorization and x-api-key, and resolves status/headers/body on 200', async () => {
  pool()
    .intercept({ path: '/v1/status/abc', method: 'GET' })
    .reply(
      200,
      (opts) => {
        expect(opts.headers).toMatchObject({
          Authorization: 'Bearer TOKEN_1',
          'x-api-key': 'my-client-id',
        });
        return { jobId: 'abc', status: 'running' };
      },
      { headers: { 'x-request-id': 'req-1' } },
    );

  const client = new HttpClient({ apiKey: 'my-client-id', tokenProvider });
  const res = await client.request<{ jobId: string; status: string }>('GET', '/v1/status/abc');

  expect(res.status).toBe(200);
  expect(res.headers['x-request-id']).toBe('req-1');
  expect(res.body).toEqual({ jobId: 'abc', status: 'running' });
});

/**
 * Native `fetch()` hands a MockAgent reply callback the request body as an
 * async generator of chunks (a plain string, as the undici types suggest,
 * is only what the lower-level `dispatch`/`request` API sees) — drain it to
 * the raw text actually sent.
 */
async function readMockBody(body: unknown): Promise<string> {
  let raw = '';
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    raw += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  }
  return raw;
}

test('sends a JSON body with Content-Type on a POST, and none for a bodyless GET', async () => {
  pool()
    .intercept({ path: '/v1/templates/render', method: 'POST' })
    .reply(202, async (opts) => {
      expect(opts.headers).toMatchObject({ 'Content-Type': 'application/json' });
      expect(JSON.parse(await readMockBody(opts.body))).toEqual({ source: { url: 'https://x/y' } });
      return { jobId: 'j1', statusUrl: 'https://audio-video-api.adobe.io/v1/status/j1' };
    });
  pool()
    .intercept({ path: '/v1/status/j1', method: 'GET' })
    .reply(200, (opts) => {
      expect((opts.headers as Record<string, string>)['Content-Type']).toBeUndefined();
      return { status: 'running' };
    });

  const client = new HttpClient({ apiKey: 'key', tokenProvider });
  await client.request('POST', '/v1/templates/render', { source: { url: 'https://x/y' } });
  await client.request('GET', '/v1/status/j1');
});

test('a caller-supplied header merges over (and can override) the computed defaults', async () => {
  pool()
    .intercept({ path: '/v1/presets', method: 'GET' })
    .reply(200, (opts) => {
      expect(opts.headers).toMatchObject({ 'x-trace-id': 'trace-1', Accept: 'text/plain' });
      return {};
    });

  const client = new HttpClient({ apiKey: 'key', tokenProvider });
  await client.request('GET', '/v1/presets', undefined, {
    headers: { 'x-trace-id': 'trace-1', Accept: 'text/plain' },
  });
});

test("an absolute URL on the client's own origin (e.g. a returned statusUrl) is used as-is", async () => {
  pool().intercept({ path: '/v1/status/xyz', method: 'GET' }).reply(200, { status: 'completed' });

  const client = new HttpClient({ apiKey: 'key', tokenProvider });
  const res = await client.request<{ status: string }>('GET', `${DEFAULT_HOST}/v1/status/xyz`);
  expect(res.body.status).toBe('completed');
});

// --- credentials never leave the configured origin ----------------------------------

/** Counts every request that reaches `origin`, whatever its path or method. */
function countingOrigin(origin: string): () => number {
  let hits = 0;
  agent
    .get(origin)
    .intercept({ path: () => true, method: () => true })
    .reply(200, () => {
      hits += 1;
      return {};
    })
    .persist();
  return () => hits;
}

/** The tail every refused-URL message ends with. */
const NOT_SENT = ': it was not requested, and no credentials were sent.';

test.each([
  [
    'another host',
    'https://other-host.example/v1/status/xyz',
    'The request URL is on https://other-host.example, not https://audio-video-api.adobe.io',
  ],
  [
    'another port',
    'https://audio-video-api.adobe.io:8443/v1/status/xyz',
    'The request URL is on https://audio-video-api.adobe.io:8443, not https://audio-video-api.adobe.io',
  ],
  [
    'http: where the host is https:',
    'http://audio-video-api.adobe.io/v1/status/xyz',
    'The request URL is on http://audio-video-api.adobe.io, not https://audio-video-api.adobe.io',
  ],
  [
    'a protocol-relative URL',
    '//other-host.example/v1/status/xyz',
    'The request URL is on https://other-host.example, not https://audio-video-api.adobe.io',
  ],
  [
    'user credentials',
    'https://user:URL_PASSWORD@audio-video-api.adobe.io/v1/status/xyz',
    'The request URL carries user credentials',
  ],
  [
    'a URL that does not parse',
    'http://[not-a-host/v1/status',
    'The request URL is not a valid URL',
  ],
])(
  'a caller-supplied path with %s is refused invalid_argument before any token or header',
  async (_case, path, message) => {
    const elsewhere = countingOrigin('https://other-host.example');

    const err = await rejection(
      new HttpClient({ apiKey: 'key', tokenProvider }).request('GET', path),
    );

    expect(err.code).toBe('invalid_argument');
    expect(err.message).toBe(message + NOT_SENT);
    expect(err.message).not.toContain('URL_PASSWORD');
    expect(getAccessTokenMock).not.toHaveBeenCalled();
    expect(elsewhere()).toBe(0);
  },
);

test('a path that came from a response body and leaves the origin is refused invalid_response', async () => {
  const collector = countingOrigin('http://collector.example');

  const err = await rejection(
    new HttpClient({ apiKey: 'key', tokenProvider }).request(
      'GET',
      'http://collector.example/poll/j2',
      undefined,
      { fromResponse: true },
    ),
  );

  expect(err.code).toBe('invalid_response');
  expect(err.message).toBe(
    'The URL the response named is on http://collector.example, not https://audio-video-api.adobe.io' +
      NOT_SENT,
  );
  expect(collector()).toBe(0);
  expect(getAccessTokenMock).not.toHaveBeenCalled();
});

test('a redirect is not followed: the 3xx rejects as http_3xx and its target receives nothing', async () => {
  const elsewhere = countingOrigin('https://other-host.example');
  pool()
    .intercept({ path: '/v1/presets', method: 'GET' })
    .reply(302, '', { headers: { location: 'https://other-host.example/collect' } });

  const err = await rejection(
    new HttpClient({ apiKey: 'key', tokenProvider }).request('GET', '/v1/presets'),
  );

  expect(err.code).toBe('http_302');
  expect(elsewhere()).toBe(0);
});

test('a plain-http host serves http paths on its own origin, and refuses https ones', async () => {
  const local = 'http://localhost:8080';
  agent.get(local).intercept({ path: '/v1/presets', method: 'GET' }).reply(200, { ok: true });
  const client = new HttpClient({ host: local, apiKey: 'key', tokenProvider });

  await expect(client.request('GET', '/v1/presets')).resolves.toMatchObject({ status: 200 });
  expect((await rejection(client.request('GET', 'https://localhost:8080/v1/presets'))).code).toBe(
    'invalid_argument',
  );
});

test.each([
  [
    'not a URL',
    'audio-video-api.adobe.io',
    'host must be an http(s) URL, e.g. https://audio-video-api.adobe.io.',
  ],
  [
    'not http(s)',
    'ftp://files.example',
    'host must be an http(s) URL, e.g. https://audio-video-api.adobe.io.',
  ],
  [
    'carrying user credentials',
    'https://svc:HOST_PASSWORD@audio-video-api.adobe.io',
    'host must not carry user credentials (user:password@).',
  ],
])('a host %s is refused invalid_argument at construction', (_case, host, message) => {
  let thrown: unknown;
  try {
    new HttpClient({ host, apiKey: 'key', tokenProvider });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AudioVideoError);
  expect((thrown as AudioVideoError).code).toBe('invalid_argument');
  expect((thrown as AudioVideoError).message).toBe(message);
});

// --- the request signal reaches the token provider -----------------------------------

test('the request signal is handed to the token provider, on the first call and on a forced refresh', async () => {
  const { signal } = new AbortController();
  getAccessTokenMock
    .mockReset()
    .mockResolvedValueOnce('STALE_TOKEN')
    .mockResolvedValueOnce('FRESH');
  pool().intercept({ path: '/v1/presets', method: 'GET' }).reply(401, { error: 'unauthorized' });
  pool().intercept({ path: '/v1/presets', method: 'GET' }).reply(200, { presets: [] });

  await new HttpClient({ apiKey: 'key', tokenProvider }).request('GET', '/v1/presets', undefined, {
    signal,
  });

  expect(getAccessTokenMock).toHaveBeenNthCalledWith(1, { signal });
  expect(getAccessTokenMock).toHaveBeenNthCalledWith(2, { forceRefresh: true, signal });
  expect(getEventListeners(signal, 'abort')).toHaveLength(0);
});

test('an abort while a token provider that ignores the signal is still pending rejects cancelled at once', async () => {
  getAccessTokenMock.mockReset().mockReturnValue(new Promise<string>(() => undefined));
  const controller = new AbortController();

  const pending = new HttpClient({ apiKey: 'key', tokenProvider }).request(
    'GET',
    '/v1/presets',
    undefined,
    { signal: controller.signal },
  );
  await until(() => getAccessTokenMock.mock.calls.length === 1);
  controller.abort(new Error('stop waiting'));

  const err = await rejection(pending);
  expect(err.code).toBe('cancelled');
  expect((err.cause as Error).message).toBe('stop waiting');
  expect(agent.pendingInterceptors()).toHaveLength(0);
});

test('an empty response body resolves body as undefined', async () => {
  pool().intercept({ path: '/v1/cancel/j1', method: 'PUT' }).reply(200, '');

  const client = new HttpClient({ apiKey: 'key', tokenProvider });
  const res = await client.request('PUT', '/v1/cancel/j1');
  expect(res.body).toBeUndefined();
});

test('a non-empty, non-JSON response body is surfaced as raw text rather than dropped', async () => {
  pool().intercept({ path: '/v1/presets', method: 'GET' }).reply(200, 'not json at all');

  const client = new HttpClient({ apiKey: 'key', tokenProvider });
  const res = await client.request<string>('GET', '/v1/presets');
  expect(res.body).toBe('not json at all');
});

// --- 429 backoff -----------------------------------------------------------------

test('429 with Retry-After: 0 then 200 — one retry, two upstream calls, resolves', async () => {
  pool()
    .intercept({ path: '/v1/presets', method: 'GET' })
    .reply(429, { error: 'rate_limit' }, { headers: { 'retry-after': '0' } });
  pool().intercept({ path: '/v1/presets', method: 'GET' }).reply(200, { presets: [] });

  const client = new HttpClient({ apiKey: 'key', tokenProvider });
  const res = await client.request<{ presets: unknown[] }>('GET', '/v1/presets');

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ presets: [] });
  expect(agent.pendingInterceptors()).toHaveLength(0);
});

/** Fakes the clock and `setTimeout` only, so real macrotasks keep driving the mocked fetch. */
function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
}

/**
 * Queues one reply per entry on `GET /v1/presets` — a `429` (with the given
 * `Retry-After`, when one is set) or a `200` — and returns how many requests
 * have reached them so far.
 */
function presetsReplies(
  ...replies: Array<{ status: 200 | 429; retryAfter?: string }>
): () => number {
  let sent = 0;
  for (const { status, retryAfter } of replies) {
    pool()
      .intercept({ path: '/v1/presets', method: 'GET' })
      .reply(
        status,
        () => {
          sent += 1;
          return status === 200 ? { presets: [] } : { error: 'rate_limit' };
        },
        retryAfter === undefined ? {} : { headers: { 'retry-after': retryAfter } },
      );
  }
  return () => sent;
}

/**
 * Proves the next retry goes out exactly `delayMs` after its backoff starts:
 * one millisecond short of it the backoff timer is still pending and no new
 * request has been sent; at `delayMs` the next request reaches the server.
 */
async function expectRetryAfter(delayMs: number, sent: () => number): Promise<void> {
  await until(() => vi.getTimerCount() === 1);
  const before = sent();
  await vi.advanceTimersByTimeAsync(delayMs - 1);
  await flush();
  expect(sent(), `no request before ${delayMs} ms`).toBe(before);
  expect(vi.getTimerCount(), `the backoff is still pending at ${delayMs - 1} ms`).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await until(() => sent() === before + 1);
}

test('a Retry-After in seconds delays the retry by exactly that long', async () => {
  useFakeClock();
  const sent = presetsReplies({ status: 429, retryAfter: '7' }, { status: 200 });

  const pending = new HttpClient({ apiKey: 'key', tokenProvider }).request('GET', '/v1/presets');

  await expectRetryAfter(7_000, sent);
  await expect(pending).resolves.toMatchObject({ status: 200 });
});

test('an HTTP-date Retry-After delays the retry until that time', async () => {
  useFakeClock();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  const retryAt = new Date('2026-01-01T00:00:05.000Z').toUTCString();
  const sent = presetsReplies({ status: 429, retryAfter: retryAt }, { status: 200 });

  const pending = new HttpClient({ apiKey: 'key', tokenProvider }).request('GET', '/v1/presets');

  await expectRetryAfter(5_000, sent);
  await expect(pending).resolves.toMatchObject({ status: 200 });
});

test.each([
  ['120 seconds', () => '120'],
  ['an HTTP-date an hour out', () => new Date(Date.now() + 3_600_000).toUTCString()],
  ['3,000,000 seconds, past the largest delay setTimeout honors', () => '3000000'],
])('a Retry-After of %s is capped at 60 s', async (_case, retryAfter) => {
  useFakeClock();
  const sent = presetsReplies({ status: 429, retryAfter: retryAfter() }, { status: 200 });

  const pending = new HttpClient({ apiKey: 'key', tokenProvider }).request('GET', '/v1/presets');

  await expectRetryAfter(60_000, sent);
  await expect(pending).resolves.toMatchObject({ status: 200 });
});

test.each([
  ['a negative', () => '-5'],
  ['a non-finite', () => '1e400'],
  ['an unparseable', () => 'not-a-number-or-date'],
  ['an empty', () => ''],
  ['a past HTTP-date', () => new Date(Date.now() - 3_600_000).toUTCString()],
])('%s Retry-After falls back to the jittered exponential backoff', async (_case, retryAfter) => {
  useFakeClock();
  vi.spyOn(Math, 'random').mockReturnValue(0.25);
  const sent = presetsReplies({ status: 429, retryAfter: retryAfter() }, { status: 200 });

  const pending = new HttpClient({ apiKey: 'key', tokenProvider }).request('GET', '/v1/presets');

  // A quarter of the first attempt's 1 s base delay.
  await expectRetryAfter(250, sent);
  await expect(pending).resolves.toMatchObject({ status: 200 });
});

test('without Retry-After, each retry waits a uniform fraction of a doubling delay capped at 60 s before the fraction is taken', async () => {
  useFakeClock();
  const fractions = [0.25, 0.75, 0.5, 0.5, 0.5, 0.5, 0.5, 0.999];
  const random = vi.spyOn(Math, 'random');
  for (const fraction of fractions) random.mockReturnValueOnce(fraction);
  const sent = presetsReplies(...fractions.map(() => ({ status: 429 as const })), { status: 200 });

  const client = new HttpClient({ apiKey: 'key', tokenProvider, maxRetries: fractions.length });
  const pending = client.request('GET', '/v1/presets');

  // min(60 s, 1 s × 2^attempt) × the fraction drawn for that attempt.
  for (const delayMs of [250, 1_500, 2_000, 4_000, 8_000, 16_000, 30_000, 59_940]) {
    await expectRetryAfter(delayMs, sent);
  }
  await expect(pending).resolves.toMatchObject({ status: 200 });
});

test('a 202 carrying Retry-After resolves at once — the header is read on a 429 only', async () => {
  useFakeClock();
  pool()
    .intercept({ path: '/v1/templates/render', method: 'POST' })
    .reply(202, { jobId: 'j1' }, { headers: { 'retry-after': '1' } });

  let settled = false;
  const pending = new HttpClient({ apiKey: 'key', tokenProvider }).request(
    'POST',
    '/v1/templates/render',
    {},
  );
  void pending.then(() => {
    settled = true;
  });

  // The fake clock never moves, so a request waiting on that header would never settle.
  await until(() => settled);
  expect(vi.getTimerCount()).toBe(0);
  await expect(pending).resolves.toMatchObject({ status: 202 });
});

test('429 exhausting maxRetries throws a redacted AudioVideoError, not an infinite retry', async () => {
  pool()
    .intercept({ path: '/v1/presets', method: 'GET' })
    .reply(429, { error: 'rate_limit' }, { headers: { 'retry-after': '0' } });

  const client = new HttpClient({ apiKey: 'key', tokenProvider, maxRetries: 0 });
  const err: unknown = await client.request('GET', '/v1/presets').catch((e: unknown) => e);

  expect(err).toBeInstanceOf(AudioVideoError);
  expect((err as AudioVideoError).status).toBe(429);
  expect((err as AudioVideoError).code).toBe('http_429');
  expect(agent.pendingInterceptors()).toHaveLength(0);
});

// --- non-2xx + redaction ---------------------------------------------------------

test('a non-2xx response throws AudioVideoError whose serialized form has no sig=/bearer/api-key', async () => {
  pool()
    .intercept({ path: '/v1/templates/render', method: 'POST' })
    .reply(
      403,
      {
        error: 'forbidden',
        source: 'https://x.blob.core.windows.net/f?sv=2021&sig=SUPER_SECRET&se=2026',
        authorization: 'Bearer LEAKED_TOKEN',
      },
      { headers: { 'x-request-id': 'req-err-1' } },
    );

  const client = new HttpClient({ apiKey: 'key', tokenProvider });
  const err: unknown = await client
    .request('POST', '/v1/templates/render', { source: { url: 'https://x/y?sig=ALSO_SECRET' } })
    .catch((e: unknown) => e);

  expect(err).toBeInstanceOf(AudioVideoError);
  const e = err as AudioVideoError;
  expect(e.status).toBe(403);
  expect(e.code).toBe('http_403');
  expect(e.requestId).toBe('req-err-1');

  const serialized = [JSON.stringify(e), String(e), inspect(e), e.message];
  for (const s of serialized) {
    expect(s).not.toContain('SUPER_SECRET');
    expect(s).not.toContain('LEAKED_TOKEN');
    expect(s).not.toContain('sig=');
  }
});

// --- 401 auth-retry ---------------------------------------------------------------

test('401 forces a token refresh and retries once, then resolves on 200', async () => {
  getAccessTokenMock.mockReset();
  getAccessTokenMock.mockResolvedValueOnce('STALE_TOKEN').mockResolvedValueOnce('FRESH_TOKEN');

  pool()
    .intercept({ path: '/v1/presets', method: 'GET' })
    .reply(401, (opts) => {
      expect(opts.headers).toMatchObject({ Authorization: 'Bearer STALE_TOKEN' });
      return { error: 'unauthorized' };
    });
  pool()
    .intercept({ path: '/v1/presets', method: 'GET' })
    .reply(200, (opts) => {
      expect(opts.headers).toMatchObject({ Authorization: 'Bearer FRESH_TOKEN' });
      return { presets: [] };
    });

  const client = new HttpClient({ apiKey: 'key', tokenProvider });
  const res = await client.request<{ presets: unknown[] }>('GET', '/v1/presets');

  expect(res.status).toBe(200);
  expect(getAccessTokenMock).toHaveBeenCalledTimes(2);
  expect(getAccessTokenMock).toHaveBeenNthCalledWith(1);
  expect(getAccessTokenMock).toHaveBeenNthCalledWith(2, { forceRefresh: true });
});

test('401 twice throws — no infinite loop, and forceRefresh is only requested once', async () => {
  getAccessTokenMock.mockReset();
  getAccessTokenMock.mockResolvedValueOnce('STALE_TOKEN').mockResolvedValueOnce('STILL_BAD_TOKEN');

  pool().intercept({ path: '/v1/presets', method: 'GET' }).reply(401, { error: 'unauthorized' });
  pool().intercept({ path: '/v1/presets', method: 'GET' }).reply(401, { error: 'unauthorized' });

  const client = new HttpClient({ apiKey: 'key', tokenProvider });
  const err: unknown = await client.request('GET', '/v1/presets').catch((e: unknown) => e);

  expect(err).toBeInstanceOf(AudioVideoError);
  expect((err as AudioVideoError).status).toBe(401);
  expect((err as AudioVideoError).code).toBe('http_401');
  expect(getAccessTokenMock).toHaveBeenCalledTimes(2);
  expect(agent.pendingInterceptors()).toHaveLength(0);
});

// --- cancellation ------------------------------------------------------------------

test('a caller signal that is already aborted rejects cancelled without hitting the network', async () => {
  const client = new HttpClient({ apiKey: 'key', tokenProvider });
  const controller = new AbortController();
  controller.abort();

  const err = await rejection(
    client.request('GET', '/v1/presets', undefined, { signal: controller.signal }),
  );

  expect(err.code).toBe('cancelled');
  expect(err.message).toBe(`Request to ${DEFAULT_HOST}/v1/presets was cancelled.`);
  expect((err.cause as Error).name).toBe('AbortError');
  expect(getAccessTokenMock).not.toHaveBeenCalled();
  expect(agent.pendingInterceptors()).toHaveLength(0);
});

test('aborting the caller signal mid-request rejects the in-flight request cancelled', async () => {
  const scope = pool()
    .intercept({ path: '/v1/presets', method: 'GET' })
    .reply(200, { presets: [] });
  scope.delay(50);

  const client = new HttpClient({ apiKey: 'key', tokenProvider });
  const controller = new AbortController();

  const pending = client.request('GET', '/v1/presets', undefined, { signal: controller.signal });
  queueMicrotask(() => controller.abort());

  expect((await rejection(pending)).code).toBe('cancelled');
});

test('aborting the caller signal during a 429 backoff wait rejects cancelled at once, with a copy of the reason as cause', async () => {
  useFakeClock();
  pool()
    .intercept({ path: '/v1/presets', method: 'GET' })
    .reply(429, { error: 'rate_limit' }, { headers: { 'retry-after': '10' } });

  const client = new HttpClient({ apiKey: 'key', tokenProvider });
  const controller = new AbortController();
  const abortReason = new Error('caller gave up');

  const pending = client.request('GET', '/v1/presets', undefined, { signal: controller.signal });

  // The 10 s backoff is armed and the fake clock never reaches it.
  await until(() => vi.getTimerCount() === 1);
  controller.abort(abortReason);

  const err = await rejection(pending);
  expect(err.code).toBe('cancelled');
  expect(err.cause).not.toBe(abortReason);
  expect((err.cause as Error).message).toBe('caller gave up');
  expect(vi.getTimerCount()).toBe(0);
});

test('a signal aborted in the gap between attempts short-circuits the next wait rather than sleeping it out', async () => {
  const controller = new AbortController();
  const abortReason = new Error('gave up between attempts');

  pool()
    .intercept({ path: '/v1/presets', method: 'GET' })
    .reply(429, { error: 'rate_limit' }, { headers: { 'retry-after': '0' } });
  pool()
    .intercept({ path: '/v1/presets', method: 'GET' })
    .reply(
      429,
      () => {
        // Simulates the signal aborting in the window between one attempt's response
        // and the next `sleep()` call — by the time `sleep()` runs, `signal.aborted`
        // is already `true`, which only its own up-front check (not the 'abort'
        // listener, which cannot fire for a transition that already happened) catches.
        // Deferred a microtask so the abort fires after undici's own dispatch of
        // *this* response has fully unwound, rather than re-entrantly from inside it.
        queueMicrotask(() => controller.abort(abortReason));
        return { error: 'rate_limit' };
      },
      { headers: { 'retry-after': '10' } },
    );

  const client = new HttpClient({ apiKey: 'key', tokenProvider, maxRetries: 5 });

  // Real timers: if the already-aborted signal were NOT short-circuited, this would
  // hang waiting out a real 10-second delay and fail on the test timeout instead.
  const err = await rejection(
    client.request('GET', '/v1/presets', undefined, { signal: controller.signal }),
  );
  expect(err.code).toBe('cancelled');
  expect((err.cause as Error).message).toBe('gave up between attempts');
});

// --- every other failure is an AudioVideoError too ----------------------------------

test('a transport failure rejects request_failed, naming its system code, with a redacted copy of the error chain as cause', async () => {
  const signedUrl = 'https://acct.blob.core.windows.net/c/f.mov?sv=2021&sig=TRANSPORT_SIG';
  const raw = Object.assign(new Error(`connect failed for ${signedUrl}`), { code: 'ECONNRESET' });
  pool().intercept({ path: '/v1/presets', method: 'GET' }).replyWithError(raw);

  const err = await rejection(
    new HttpClient({ apiKey: 'key', tokenProvider }).request('GET', '/v1/presets'),
  );

  expect(err.code).toBe('request_failed');
  expect(err.message).toBe(
    `Request to ${DEFAULT_HOST}/v1/presets failed before a complete response arrived (ECONNRESET).`,
  );
  // fetch's own `TypeError: fetch failed`, whose cause is the connection error.
  const cause = err.cause as Error;
  expect(cause.name).toBe('TypeError');
  expect(cause.message).toBe('fetch failed');
  const inner = cause.cause as Error & { code?: unknown };
  expect(inner).not.toBe(raw);
  expect(inner.code).toBe('ECONNRESET');
  expect(inner.message).toBe('connect failed for https://acct.blob.core.windows.net/c/f.mov');
  expect(inspect(err.cause, { depth: null })).not.toContain('TRANSPORT_SIG');
});

test("this client's own per-attempt timeout rejects request_timeout", async () => {
  const attemptTimeout = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(attemptTimeout.signal);
  const held = deferred();
  let arrived = false;
  pool()
    .intercept({ path: '/v1/presets', method: 'GET' })
    .reply(200, async () => {
      arrived = true;
      await held.promise;
      return { presets: [] };
    });

  const pending = new HttpClient({ apiKey: 'key', tokenProvider }).request('GET', '/v1/presets');
  await until(() => arrived);
  attemptTimeout.abort(new DOMException('The operation timed out.', 'TimeoutError'));

  const err = await rejection(pending);
  held.resolve();
  expect(err.code).toBe('request_timeout');
  expect(err.message).toBe(
    `Request to ${DEFAULT_HOST}/v1/presets did not complete within 30 seconds.`,
  );
  expect((err.cause as Error).name).toBe('TimeoutError');
});

test('a token provider failing with a plain error rejects auth_failed with a redacted copy of it as cause', async () => {
  const raw = new Error('vault unreachable: https://vault.example/v1/token?sig=VAULT_SIG');
  getAccessTokenMock.mockReset().mockRejectedValue(raw);

  const err = await rejection(
    new HttpClient({ apiKey: 'key', tokenProvider }).request('GET', '/v1/presets'),
  );

  expect(err.code).toBe('auth_failed');
  expect(err.cause).not.toBe(raw);
  expect((err.cause as Error).message).toBe('vault unreachable: https://vault.example/v1/token');
  expect(agent.pendingInterceptors()).toHaveLength(0);
});

test('a forced refresh after a 401 that fails with a plain error rejects auth_failed', async () => {
  getAccessTokenMock
    .mockReset()
    .mockResolvedValueOnce('STALE_TOKEN')
    .mockRejectedValueOnce(new TypeError('refresh broke'));
  pool().intercept({ path: '/v1/presets', method: 'GET' }).reply(401, { error: 'unauthorized' });

  const err = await rejection(
    new HttpClient({ apiKey: 'key', tokenProvider }).request('GET', '/v1/presets'),
  );

  expect(err.code).toBe('auth_failed');
  expect((err.cause as Error).name).toBe('TypeError');
});

test('an AudioVideoError from the token provider passes through unchanged', async () => {
  const failure = new AudioVideoError({ message: 'no token', code: 'auth_failed' });
  getAccessTokenMock.mockReset().mockRejectedValue(failure);

  const err = await rejection(
    new HttpClient({ apiKey: 'key', tokenProvider }).request('GET', '/v1/presets'),
  );

  expect(err).toBe(failure);
});
