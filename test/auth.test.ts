import { inspect } from 'node:util';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  ClientCredentialsProvider,
  DEFAULT_SCOPE,
  DEFAULT_TOKEN_TTL_MS,
  resolveTokenProvider,
} from '../src/core/auth.js';
import { AudioVideoError } from '../src/core/errors.js';
import { FakeIms, deferred } from './support/fake-ims.js';
import { until } from './support/mock-api.js';

const CLIENT_ID = 'client-id';
const SECRET = 'TOP_SECRET_VALUE';
const CREDS = { clientId: CLIENT_ID, clientSecret: SECRET };

let ims: FakeIms;

beforeEach(() => {
  ims = new FakeIms();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await ims.close();
});

/** Fakes the clock and `setTimeout` only, so real macrotasks keep draining the fetch path. */
function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
}

/** Builds an unsigned, syntactically valid JWT carrying `claims` as its payload. */
function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.signature`;
}

// --- resolveTokenProvider ----------------------------------------------------

test('resolveTokenProvider returns an already-built TokenProvider unchanged', () => {
  const provider = { getAccessToken: async () => 'T' };
  expect(resolveTokenProvider(provider)).toBe(provider);
});

test('resolveTokenProvider builds a working ClientCredentialsProvider from credentials', async () => {
  ims.token('TOKEN_1');
  const provider = resolveTokenProvider(CREDS);
  expect(provider).toBeInstanceOf(ClientCredentialsProvider);
  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_1');
});

// --- the token request -----------------------------------------------------------

test('the token request carries the credentials and DEFAULT_SCOPE, comma-joined, byte for byte', async () => {
  ims.token('TOKEN_1');
  await new ClientCredentialsProvider(CREDS).getAccessToken();

  expect(DEFAULT_SCOPE).toBe('openid,AdobeID,firefly_api,ff_apis');
  expect(ims.requests).toEqual([
    `grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${SECRET}&scope=${DEFAULT_SCOPE}`,
  ]);
});

test('a custom scope is sent straight through unchanged', async () => {
  ims.token('TOKEN_1');
  await new ClientCredentialsProvider({ ...CREDS, scope: 'openid,foo' }).getAccessToken();
  expect(ims.form(0).get('scope')).toBe('openid,foo');
});

// --- caching -------------------------------------------------------------------

test('caches the token: two calls before expiry mint only once', async () => {
  ims.token('TOKEN_1');
  ims.token('TOKEN_2');
  const provider = new ClientCredentialsProvider(CREDS, {
    tokenTtlMs: 10_000,
    refreshMarginMs: 1_000,
  });

  const a = await provider.getAccessToken();
  const b = await provider.getAccessToken();

  expect(a).toBe('TOKEN_1');
  expect(b).toBe('TOKEN_1');
  expect(ims.requests).toHaveLength(1);
});

test('re-mints once the cached token nears its assumed expiry', async () => {
  useFakeClock();
  ims.token('TOKEN_1');
  ims.token('TOKEN_2');
  const provider = new ClientCredentialsProvider(CREDS, {
    tokenTtlMs: 10_000,
    refreshMarginMs: 1_000,
  });

  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_1');

  // 9_500ms elapsed: within the 1_000ms refresh margin of the 10_000ms assumed TTL.
  await vi.advanceTimersByTimeAsync(9_500);

  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
  expect(ims.requests).toHaveLength(2);
});

test('concurrent callers while a mint is in flight share one IMS request', async () => {
  const held = deferred();
  ims.token('TOKEN_1', { hold: held.promise });
  const provider = new ClientCredentialsProvider(CREDS);

  const calls = Array.from({ length: 10 }, () => provider.getAccessToken());
  await until(() => ims.requests.length === 1);
  held.resolve();

  await expect(Promise.all(calls)).resolves.toEqual(Array(10).fill('TOKEN_1'));
  expect(ims.requests).toHaveLength(1);
});

// --- forceRefresh --------------------------------------------------------------

test('forceRefresh bypasses the cache and re-mints even when not near expiry', async () => {
  ims.token('TOKEN_1');
  ims.token('TOKEN_2');
  const provider = new ClientCredentialsProvider(CREDS);

  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_1');
  await expect(provider.getAccessToken({ forceRefresh: true })).resolves.toBe('TOKEN_2');
  expect(ims.requests).toHaveLength(2);

  // the forced mint is now the cached token — a plain call returns it without minting again.
  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
  expect(ims.requests).toHaveLength(2);
});

test('a forceRefresh call that arrives while a mint is already in flight shares it', async () => {
  const held = deferred();
  ims.token('TOKEN_1', { hold: held.promise });
  const provider = new ClientCredentialsProvider(CREDS);

  const first = provider.getAccessToken();
  const forced = provider.getAccessToken({ forceRefresh: true });
  await until(() => ims.requests.length === 1);
  held.resolve();

  await expect(first).resolves.toBe('TOKEN_1');
  await expect(forced).resolves.toBe('TOKEN_1');
  expect(ims.requests).toHaveLength(1);
});

// --- JWT exp decode --------------------------------------------------------------

test('a decodable JWT exp claim drives the cache expiry, not the assumed TTL', async () => {
  useFakeClock();
  const expSeconds = Math.floor(Date.now() / 1000) + 120; // 2 minutes from mint time.
  const jwt = fakeJwt({ exp: expSeconds });
  ims.token(jwt);
  ims.token('TOKEN_2');
  // Default options: if DEFAULT_TOKEN_TTL_MS (24h) were driving the cache instead of the
  // JWT's own exp, neither advance below would come anywhere near a re-mint.
  const provider = new ClientCredentialsProvider(CREDS);

  await expect(provider.getAccessToken()).resolves.toBe(jwt);

  // 59s elapsed: still inside the 120s JWT lifetime minus the default 60s refresh margin.
  await vi.advanceTimersByTimeAsync(59_000);
  await expect(provider.getAccessToken()).resolves.toBe(jwt);
  expect(ims.requests).toHaveLength(1);

  // past the 60s-before-expiry boundary (120s - 60s = 60s elapsed): re-mints.
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
  expect(ims.requests).toHaveLength(2);
});

test('a JWT with no exp claim falls back to the configured TTL', async () => {
  useFakeClock();
  const jwt = fakeJwt({ sub: 'someone' });
  ims.token(jwt);
  ims.token('TOKEN_2');
  const provider = new ClientCredentialsProvider(CREDS, {
    tokenTtlMs: 10_000,
    refreshMarginMs: 1_000,
  });

  await expect(provider.getAccessToken()).resolves.toBe(jwt);
  await vi.advanceTimersByTimeAsync(9_500);
  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
  expect(ims.requests).toHaveLength(2);
});

test('a JWT whose payload decodes to a non-object JSON value falls back to the configured TTL', async () => {
  useFakeClock();
  // A syntactically valid JWT (three segments, valid base64url/JSON payload) whose
  // payload is a bare number rather than a claims object — `42.exp` is not a thing.
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from('42').toString('base64url');
  const jwt = `${header}.${payload}.sig`;
  ims.token(jwt);
  ims.token('TOKEN_2');
  const provider = new ClientCredentialsProvider(CREDS, {
    tokenTtlMs: 10_000,
    refreshMarginMs: 1_000,
  });

  await expect(provider.getAccessToken()).resolves.toBe(jwt);
  await vi.advanceTimersByTimeAsync(9_500);
  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
  expect(ims.requests).toHaveLength(2);
});

test('a JWT-shaped token with an undecodable payload never throws and falls back to the configured TTL', async () => {
  useFakeClock();
  ims.token('a.not-valid-base64url-json.c');
  ims.token('TOKEN_2');
  const provider = new ClientCredentialsProvider(CREDS, {
    tokenTtlMs: 10_000,
    refreshMarginMs: 1_000,
  });

  await expect(provider.getAccessToken()).resolves.toBe('a.not-valid-base64url-json.c');
  await vi.advanceTimersByTimeAsync(9_500);
  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
  expect(ims.requests).toHaveLength(2);
});

test('a non-JWT opaque token falls back to DEFAULT_TOKEN_TTL_MS when no tokenTtlMs is configured', async () => {
  useFakeClock();
  ims.token('OPAQUE_TOKEN_NOT_A_JWT');
  ims.token('TOKEN_2');
  const provider = new ClientCredentialsProvider(CREDS);

  await expect(provider.getAccessToken()).resolves.toBe('OPAQUE_TOKEN_NOT_A_JWT');

  // Just inside DEFAULT_TOKEN_TTL_MS (24h) minus the default 60s refresh margin: no re-mint.
  await vi.advanceTimersByTimeAsync(DEFAULT_TOKEN_TTL_MS - 60_000 - 1_000);
  await expect(provider.getAccessToken()).resolves.toBe('OPAQUE_TOKEN_NOT_A_JWT');
  expect(ims.requests).toHaveLength(1);

  // past that boundary: re-mints.
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
  expect(ims.requests).toHaveLength(2);
});

// --- failure -------------------------------------------------------------------

test('an unreachable IMS rejects auth_failed, and no surface carries the secret', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const provider = new ClientCredentialsProvider(CREDS); // no answer queued: IMS is unreachable

  const err: unknown = await provider.getAccessToken().catch((e: unknown) => e);

  expect(err).toBeInstanceOf(AudioVideoError);
  expect((err as AudioVideoError).code).toBe('auth_failed');
  expect((err as AudioVideoError).cause).toBeInstanceOf(Error);
  const surfaces = [
    JSON.stringify(err),
    String(err),
    inspect(err),
    inspect((err as Error).cause, { depth: null }),
  ];
  for (const s of surfaces) {
    expect(s).not.toContain(SECRET);
  }

  // The official provider reports the failure on stderr itself; it never prints the secret.
  expect(consoleError).toHaveBeenCalledWith('Error while fetching token', expect.anything());
  expect(inspect(consoleError.mock.calls, { depth: null })).not.toContain(SECRET);
});
