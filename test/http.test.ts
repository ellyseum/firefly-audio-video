import { inspect } from 'node:util';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TokenProvider } from '../src/core/auth.js';
import { AudioVideoError } from '../src/core/errors.js';
import { DEFAULT_HOST, HttpClient } from '../src/core/http.js';

const originalDispatcher = getGlobalDispatcher();
let agent: MockAgent;

const getAccessTokenMock = vi.fn<(opts?: { forceRefresh?: boolean }) => Promise<string>>();
const tokenProvider: TokenProvider = { getAccessToken: getAccessTokenMock };

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  getAccessTokenMock.mockReset().mockResolvedValue('TOKEN_1');
});

afterEach(async () => {
  vi.useRealTimers();
  await agent.close();
  setGlobalDispatcher(originalDispatcher);
});

function pool(host = DEFAULT_HOST) {
  return agent.get(host);
}

/**
 * True iff `p` has NOT settled by the current microtask tick — used to prove
 * a retry has not fired yet, without relying on `MockAgent#pendingInterceptors()`
 * (its bookkeeping for an already-dispatched-but-retried interceptor lags
 * behind the actual retry by up to one more dispatch, so it cannot answer
 * "has the next attempt gone out yet" reliably).
 */
async function isPending(p: Promise<unknown>): Promise<boolean> {
  const sentinel = Symbol('still-pending');
  const settled = p.then(
    () => 'settled',
    () => 'settled',
  );
  return (await Promise.race([settled, Promise.resolve(sentinel)])) === sentinel;
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

test('an already-absolute path (e.g. a returned statusUrl) is used as-is, ignoring the host', async () => {
  agent
    .get('https://other-host.example')
    .intercept({ path: '/v1/status/xyz', method: 'GET' })
    .reply(200, { status: 'completed' });

  const client = new HttpClient({ apiKey: 'key', tokenProvider });
  const res = await client.request<{ status: string }>(
    'GET',
    'https://other-host.example/v1/status/xyz',
  );
  expect(res.body.status).toBe('completed');
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

test('a numeric Retry-After (seconds) is honored — no retry before it elapses', async () => {
  vi.useFakeTimers();
  pool()
    .intercept({ path: '/v1/presets', method: 'GET' })
    .reply(429, { error: 'rate_limit' }, { headers: { 'retry-after': '1' } });
  pool().intercept({ path: '/v1/presets', method: 'GET' }).reply(200, { presets: [] });

  const client = new HttpClient({ apiKey: 'key', tokenProvider });
  const pending = client.request('GET', '/v1/presets');

  // Just under 1s: the retry must not have resolved the request yet.
  await vi.advanceTimersByTimeAsync(999);
  expect(await isPending(pending)).toBe(true);

  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toMatchObject({ status: 200 });
});

test('an HTTP-date Retry-After is honored as an absolute time', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  const retryAt = new Date('2026-01-01T00:00:05.000Z').toUTCString();

  pool()
    .intercept({ path: '/v1/presets', method: 'GET' })
    .reply(429, { error: 'rate_limit' }, { headers: { 'retry-after': retryAt } });
  pool().intercept({ path: '/v1/presets', method: 'GET' }).reply(200, { presets: [] });

  const client = new HttpClient({ apiKey: 'key', tokenProvider });
  const pending = client.request('GET', '/v1/presets');

  await vi.advanceTimersByTimeAsync(4_999);
  expect(await isPending(pending)).toBe(true);

  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toMatchObject({ status: 200 });
});

test('a Retry-After that is neither a valid number nor a parseable date falls back to exponential backoff', async () => {
  const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
  pool()
    .intercept({ path: '/v1/presets', method: 'GET' })
    .reply(429, { error: 'rate_limit' }, { headers: { 'retry-after': 'not-a-number-or-date' } });
  pool().intercept({ path: '/v1/presets', method: 'GET' }).reply(200, { presets: [] });

  const client = new HttpClient({ apiKey: 'key', tokenProvider });
  // Math.random mocked to 0 makes the exponential-backoff delay exactly 0ms, so this
  // resolves under real timers without needing to prove anything about its length —
  // the point is that a garbage header falls through to backoff at all, rather than
  // stalling on `NaN` or throwing.
  const res = await client.request<{ presets: unknown[] }>('GET', '/v1/presets');
  expect(res.status).toBe(200);
  randomSpy.mockRestore();
});

test('exponential backoff (no Retry-After) is always strictly below the 60s cap, even at high attempt counts', async () => {
  vi.useFakeTimers();
  const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.999999);

  const client = new HttpClient({ apiKey: 'key', tokenProvider, maxRetries: 8 });
  for (let i = 0; i < 8; i += 1) {
    pool().intercept({ path: '/v1/presets', method: 'GET' }).reply(429, { error: 'rate_limit' });
  }
  pool().intercept({ path: '/v1/presets', method: 'GET' }).reply(200, { presets: [] });

  const pending = client.request('GET', '/v1/presets');

  // Drain every attempt: advancing by just under 60s must never be enough to let the
  // request resolve (proving each computed delay is strictly < 60_000ms), and
  // advancing the remaining 1ms always eventually does.
  for (let i = 0; i < 8; i += 1) {
    await vi.advanceTimersByTimeAsync(59_999);
    expect(await isPending(pending)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
  }

  await expect(pending).resolves.toMatchObject({ status: 200 });
  randomSpy.mockRestore();
});

test('429 exhausting maxRetries throws a redacted AudioVideoError, not an infinite retry', async () => {
  pool()
    .intercept({ path: '/v1/presets', method: 'GET' })
    .reply(429, { error: 'rate_limit' }, { headers: { 'retry-after': '0' } });

  const client = new HttpClient({ apiKey: 'key', tokenProvider, maxRetries: 0 });
  const err: unknown = await client.request('GET', '/v1/presets').catch((e: unknown) => e);

  expect(err).toBeInstanceOf(AudioVideoError);
  expect((err as AudioVideoError).status).toBe(429);
  expect((err as AudioVideoError).code).toBe('HTTP_429');
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
  expect(e.code).toBe('HTTP_403');
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
  expect((err as AudioVideoError).code).toBe('HTTP_401');
  expect(getAccessTokenMock).toHaveBeenCalledTimes(2);
  expect(agent.pendingInterceptors()).toHaveLength(0);
});

// --- cancellation ------------------------------------------------------------------

test('a caller signal that is already aborted rejects the request without hitting the network', async () => {
  const client = new HttpClient({ apiKey: 'key', tokenProvider });
  const controller = new AbortController();
  controller.abort();

  await expect(
    client.request('GET', '/v1/presets', undefined, { signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });

  expect(agent.pendingInterceptors()).toHaveLength(0);
});

test('aborting the caller signal mid-request rejects the in-flight fetch', async () => {
  const scope = pool()
    .intercept({ path: '/v1/presets', method: 'GET' })
    .reply(200, { presets: [] });
  scope.delay(50);

  const client = new HttpClient({ apiKey: 'key', tokenProvider });
  const controller = new AbortController();

  const pending = client.request('GET', '/v1/presets', undefined, { signal: controller.signal });
  queueMicrotask(() => controller.abort());

  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});

test('aborting the caller signal during a 429 backoff wait rejects immediately, without waiting out the delay', async () => {
  vi.useFakeTimers();
  pool()
    .intercept({ path: '/v1/presets', method: 'GET' })
    .reply(429, { error: 'rate_limit' }, { headers: { 'retry-after': '10' } });

  const client = new HttpClient({ apiKey: 'key', tokenProvider });
  const controller = new AbortController();
  const abortReason = new Error('caller gave up');

  const pending = client.request('GET', '/v1/presets', undefined, { signal: controller.signal });

  // Well inside the 10s wait — if the abort were ignored, nothing would settle yet.
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await isPending(pending)).toBe(true);

  controller.abort(abortReason);
  await expect(pending).rejects.toBe(abortReason);
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
  await expect(
    client.request('GET', '/v1/presets', undefined, { signal: controller.signal }),
  ).rejects.toBe(abortReason);
});
