import { getEventListeners } from 'node:events';
import { inspect } from 'node:util';
import { ServerToServerTokenProvider } from '@adobe/firefly-services-common-apis';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  ClientCredentialsProvider,
  DEFAULT_SCOPE,
  DEFAULT_TOKEN_TTL_MS,
  MINT_TIMEOUT_MS,
  MIN_TOKEN_REUSE_MS,
  resolveTokenProvider,
} from '../src/core/auth.js';
import { AudioVideoError } from '../src/core/errors.js';
import { FakeIms, deferred } from './support/fake-ims.js';
import { flush, until } from './support/mock-api.js';

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

/** A promise's settled state, readable synchronously. */
interface Tracked<T> {
  state: 'pending' | 'fulfilled' | 'rejected';
  value?: T;
  error?: unknown;
}

function track<T>(promise: Promise<T>): Tracked<T> {
  const tracked: Tracked<T> = { state: 'pending' };
  promise.then(
    (value) => {
      tracked.state = 'fulfilled';
      tracked.value = value;
    },
    (error: unknown) => {
      tracked.state = 'rejected';
      tracked.error = error;
    },
  );
  return tracked;
}

/** Every surface a caller could print an error through, its cause included. */
function surfaces(err: unknown): string[] {
  return [
    JSON.stringify(err),
    String(err),
    inspect(err),
    inspect((err as Error).cause, { depth: null }),
  ];
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

// --- expiry from the token's claims -------------------------------------------------

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

/** The claim set a real IMS access token carries — no `exp`; `created_at` and `expires_in` as strings. */
function imsClaims(
  createdAt: number | string,
  expiresIn: number | string,
): Record<string, unknown> {
  return {
    id: 'fake-token-id',
    org: 'FAKEORG@AdobeOrg',
    type: 'access_token',
    client_id: CLIENT_ID,
    user_id: 'FAKEUSER@techacct.adobe.com',
    as: 'ims-na1',
    aa_id: 'FAKEUSER@techacct.adobe.com',
    ctp: 0,
    moi: 'fake-moi',
    expires_in: expiresIn,
    scope: DEFAULT_SCOPE,
    created_at: createdAt,
  };
}

const HOUR_MS = 60 * 60 * 1000;

test.each<[label: string, form: (value: number) => number | string]>([
  ['strings, as IMS sends them', String],
  ['numbers', Number],
])(
  'a token with created_at and expires_in as %s, and no exp, is re-minted refreshMarginMs before it expires',
  async (_label, form) => {
    useFakeClock();
    vi.setSystemTime(new Date('2026-09-29T12:00:00.000Z'));
    const jwt = fakeJwt(imsClaims(form(Date.now()), form(HOUR_MS)));
    ims.token(jwt);
    ims.token('TOKEN_2');
    const provider = new ClientCredentialsProvider(CREDS, { refreshMarginMs: 300_000 });

    await expect(provider.getAccessToken()).resolves.toBe(jwt);

    // One millisecond before the refresh point (the 1h lifetime minus the 5-minute margin).
    await vi.advanceTimersByTimeAsync(HOUR_MS - 300_000 - 1);
    await expect(provider.getAccessToken()).resolves.toBe(jwt);
    expect(ims.requests).toHaveLength(1);

    // At the refresh point: re-mints, long before the 24h fallback TTL.
    await vi.advanceTimersByTimeAsync(1);
    await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
    expect(ims.requests).toHaveLength(2);
  },
);

test('exp, when present, decides the expiry over created_at and expires_in', async () => {
  useFakeClock();
  const exp = Math.floor(Date.now() / 1000) + 120; // expires in at most 2 minutes
  const jwt = fakeJwt({ ...imsClaims(String(Date.now()), String(HOUR_MS)), exp });
  ims.token(jwt);
  ims.token('TOKEN_2');
  const provider = new ClientCredentialsProvider(CREDS);

  await expect(provider.getAccessToken()).resolves.toBe(jwt);

  // Past exp minus the default 60s margin, far inside created_at + expires_in (1h): re-mints.
  await vi.advanceTimersByTimeAsync(61_000);
  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
  expect(ims.requests).toHaveLength(2);
});

test.each<[label: string, claims: (now: number) => Record<string, unknown>]>([
  ['exp an hour in the past', (now) => ({ exp: Math.floor(now / 1000) - 3_600 })],
  [
    'created_at + expires_in an hour in the past',
    (now) => imsClaims(String(now - 2 * HOUR_MS), String(HOUR_MS)),
  ],
  ['exp inside the refresh margin', (now) => ({ exp: Math.floor(now / 1000) + 30 })],
])(
  'a token with %s is reused for MIN_TOKEN_REUSE_MS, not re-minted on every call',
  async (_label, claims) => {
    useFakeClock();
    const jwt = fakeJwt(claims(Date.now()));
    ims.token(jwt);
    ims.token('TOKEN_2');
    const provider = new ClientCredentialsProvider(CREDS);

    for (let call = 0; call < 5; call += 1) {
      await expect(provider.getAccessToken()).resolves.toBe(jwt);
    }
    expect(ims.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(MIN_TOKEN_REUSE_MS - 1);
    await expect(provider.getAccessToken()).resolves.toBe(jwt);
    expect(ims.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
    expect(ims.requests).toHaveLength(2);
  },
);

test('forceRefresh mints at once even inside the minimum reuse window', async () => {
  useFakeClock();
  const expired = fakeJwt({ exp: Math.floor(Date.now() / 1000) - 3_600 });
  ims.token(expired);
  ims.token('TOKEN_2');
  const provider = new ClientCredentialsProvider(CREDS);

  await expect(provider.getAccessToken()).resolves.toBe(expired);
  await expect(provider.getAccessToken({ forceRefresh: true })).resolves.toBe('TOKEN_2');
  expect(ims.requests).toHaveLength(2);
});

test.each([
  ['only created_at', { created_at: '1790680000000' }],
  ['only expires_in', { expires_in: '3600000' }],
  ['a created_at that is not a number', { created_at: 'yesterday', expires_in: '3600000' }],
  ['an expires_in that is not a number', { created_at: '1790680000000', expires_in: '1h' }],
  ['an exp that is a string', { exp: '1790680000' }],
])('a token whose claims carry %s falls back to the configured TTL', async (_label, claims) => {
  useFakeClock();
  const jwt = fakeJwt(claims);
  ims.token(jwt);
  ims.token('TOKEN_2');
  const provider = new ClientCredentialsProvider(CREDS, {
    tokenTtlMs: 10_000,
    refreshMarginMs: 1_000,
  });

  await expect(provider.getAccessToken()).resolves.toBe(jwt);
  await vi.advanceTimersByTimeAsync(8_999);
  await expect(provider.getAccessToken()).resolves.toBe(jwt);
  await vi.advanceTimersByTimeAsync(1);
  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
  expect(ims.requests).toHaveLength(2);
});

test('a JWT whose claims give no expiry falls back to the configured TTL', async () => {
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

// --- the mint time-box -------------------------------------------------------------

test('a mint IMS has not answered within MINT_TIMEOUT_MS rejects every waiter auth_failed, and its late answer is dropped', async () => {
  useFakeClock();
  const authenticate = vi.spyOn(ServerToServerTokenProvider.prototype, 'authenticate');
  const held = deferred();
  ims.token('LATE_TOKEN', { hold: held.promise });
  ims.token('TOKEN_2');
  const provider = new ClientCredentialsProvider(CREDS);

  try {
    const waiters = [
      track(provider.getAccessToken()),
      track(provider.getAccessToken({ forceRefresh: true })),
    ];
    await until(() => ims.requests.length === 1);

    // One millisecond short of the bound: still waiting.
    await vi.advanceTimersByTimeAsync(MINT_TIMEOUT_MS - 1);
    await flush();
    expect(waiters.map((waiter) => waiter.state)).toEqual(['pending', 'pending']);

    await vi.advanceTimersByTimeAsync(1);
    await until(() => waiters.every((waiter) => waiter.state !== 'pending'));
    for (const waiter of waiters) {
      expect(waiter.state).toBe('rejected');
      expect(waiter.error).toBeInstanceOf(AudioVideoError);
      expect((waiter.error as AudioVideoError).code).toBe('auth_failed');
      expect((waiter.error as AudioVideoError).message).toBe(
        'IMS did not answer the token request within 30 seconds.',
      );
    }

    // IMS answers only now: the abandoned mint's token is dropped, not cached.
    held.resolve();
    await expect(authenticate.mock.results[0]?.value).resolves.toBe('LATE_TOKEN');
    await flush();
    await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
    expect(ims.requests).toHaveLength(2);
  } finally {
    held.resolve();
  }
});

test('a mint that settles inside the bound, resolved or rejected, leaves no timer running', async () => {
  useFakeClock();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  ims.token('TOKEN_1');
  ims.answer(502, '<html><body>Bad Gateway</body></html>');
  const provider = new ClientCredentialsProvider(CREDS);

  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_1');
  expect(vi.getTimerCount()).toBe(0);

  await expect(provider.getAccessToken({ forceRefresh: true })).rejects.toMatchObject({
    code: 'auth_failed',
  });
  expect(vi.getTimerCount()).toBe(0);
});

// --- a caller's abort signal ---------------------------------------------------------

test("one caller's abort rejects only that caller, cancelled, while the shared mint resolves the others", async () => {
  const held = deferred();
  ims.token('TOKEN_1', { hold: held.promise });
  const provider = new ClientCredentialsProvider(CREDS);
  const controller = new AbortController();
  const reason = new Error('caller gave up');

  // The aborting caller is the one whose call started the mint.
  const aborted = track(provider.getAccessToken({ signal: controller.signal }));
  const plain = track(provider.getAccessToken());
  const withSignal = track(provider.getAccessToken({ signal: new AbortController().signal }));
  try {
    await until(() => ims.requests.length === 1);

    controller.abort(reason);
    await until(() => aborted.state !== 'pending');
    expect(aborted.state).toBe('rejected');
    expect(aborted.error).toBeInstanceOf(AudioVideoError);
    expect((aborted.error as AudioVideoError).code).toBe('cancelled');
    expect((aborted.error as AudioVideoError).cause).toBe(reason);
    await flush();
    expect(plain.state).toBe('pending');
    expect(withSignal.state).toBe('pending');

    held.resolve();
    await until(() => plain.state !== 'pending' && withSignal.state !== 'pending');
    expect(plain.value).toBe('TOKEN_1');
    expect(withSignal.value).toBe('TOKEN_1');
    expect(ims.requests).toHaveLength(1);

    // The mint the aborted caller started still filled the cache.
    await expect(provider.getAccessToken()).resolves.toBe('TOKEN_1');
    expect(ims.requests).toHaveLength(1);
  } finally {
    held.resolve();
  }
});

test('an already-aborted signal rejects cancelled at once, cached token or not, and never contacts IMS', async () => {
  const authenticate = vi.spyOn(ServerToServerTokenProvider.prototype, 'authenticate');
  ims.token('TOKEN_1');
  const provider = new ClientCredentialsProvider(CREDS);
  const reason = new Error('already stopped');

  for (const round of ['cold cache', 'warm cache']) {
    const err: unknown = await provider
      .getAccessToken({ signal: AbortSignal.abort(reason) })
      .catch((e: unknown) => e);

    expect(err, round).toBeInstanceOf(AudioVideoError);
    expect((err as AudioVideoError).code, round).toBe('cancelled');
    expect((err as AudioVideoError).cause, round).toBe(reason);
    expect(authenticate, round).toHaveBeenCalledTimes(round === 'cold cache' ? 0 : 1);

    if (round === 'cold cache') {
      await expect(provider.getAccessToken()).resolves.toBe('TOKEN_1');
    }
  }
  expect(ims.requests).toHaveLength(1);
});

test('a caller whose mint settles leaves no abort listener on its signal', async () => {
  ims.token('TOKEN_1');
  ims.answer(400, { error: 'invalid_client' });
  const provider = new ClientCredentialsProvider(CREDS);
  const { signal } = new AbortController();

  await expect(provider.getAccessToken({ signal })).resolves.toBe('TOKEN_1');
  expect(getEventListeners(signal, 'abort')).toHaveLength(0);

  await expect(provider.getAccessToken({ signal, forceRefresh: true })).rejects.toMatchObject({
    code: 'auth_failed',
  });
  expect(getEventListeners(signal, 'abort')).toHaveLength(0);
});

// --- failure -------------------------------------------------------------------

test('an unreachable IMS rejects auth_failed, and no surface carries the secret', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const provider = new ClientCredentialsProvider(CREDS); // no answer queued: IMS is unreachable

  const err: unknown = await provider.getAccessToken().catch((e: unknown) => e);

  expect(err).toBeInstanceOf(AudioVideoError);
  expect((err as AudioVideoError).code).toBe('auth_failed');
  expect((err as AudioVideoError).cause).toBeInstanceOf(Error);
  for (const s of surfaces(err)) {
    expect(s).not.toContain(SECRET);
  }

  // The official provider reports the failure on stderr itself; it never prints the secret.
  expect(consoleError).toHaveBeenCalledWith('Error while fetching token', expect.anything());
  expect(inspect(consoleError.mock.calls, { depth: null })).not.toContain(SECRET);
});

// --- an IMS reply without a usable token -------------------------------------------

const UNUSABLE_REPLIES: Array<[label: string, status: number, body: object, imsError?: string]> = [
  [
    '400 invalid_client',
    400,
    { error: 'invalid_client', error_description: 'invalid client_secret parameter' },
    'invalid_client',
  ],
  [
    '400 invalid_scope',
    400,
    { error: 'invalid_scope', error_description: 'invalid scope parameter' },
    'invalid_scope',
  ],
  ['429 JSON', 429, { error_code: '429050', message: 'Too many requests' }],
  ['503 JSON', 503, { message: 'Service Unavailable' }],
  ['200 without access_token', 200, { token_type: 'bearer', expires_in: 86_399 }],
  ['200 with a numeric access_token', 200, { access_token: 12345, token_type: 'bearer' }],
  ['200 with a null access_token', 200, { access_token: null, token_type: 'bearer' }],
  ['200 with an empty access_token', 200, { access_token: '', token_type: 'bearer' }],
];

test.each(UNUSABLE_REPLIES)(
  'IMS reply %s rejects auth_failed naming the likely cause, and caches nothing',
  async (_label, status, body, imsError) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ims.answer(status, body);
    ims.token('TOKEN_2');
    const provider = new ClientCredentialsProvider(CREDS);

    const err: unknown = await provider.getAccessToken().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AudioVideoError);
    const { code, message } = err as AudioVideoError;
    expect(code).toBe('auth_failed');
    expect(message).toContain('the client ID or secret was most likely refused');
    if (imsError === undefined) {
      expect(message).not.toContain('IMS error');
    } else {
      expect(message).toContain(`(IMS error: ${imsError})`);
    }
    for (const s of surfaces(err)) {
      expect(s).not.toContain(SECRET);
    }

    // Nothing was cached: the next call asks IMS again.
    await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
    expect(ims.requests).toHaveLength(2);
    // A JSON reply never reaches the official provider's own stderr logging.
    expect(consoleError).not.toHaveBeenCalled();
  },
);

const THROWING_REPLIES: Array<[label: string, status: number, body: string]> = [
  ['502 with an HTML body', 502, '<html><body>Bad Gateway</body></html>'],
  ['200 with a JSON null body', 200, 'null'],
];

test.each(THROWING_REPLIES)(
  'IMS reply %s rejects auth_failed with the provider error as its cause, and caches nothing',
  async (_label, status, body) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ims.answer(status, body);
    ims.token('TOKEN_2');
    const provider = new ClientCredentialsProvider(CREDS);

    const err: unknown = await provider.getAccessToken().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AudioVideoError);
    expect((err as AudioVideoError).code).toBe('auth_failed');
    expect((err as AudioVideoError).cause).toBeInstanceOf(Error);
    for (const s of surfaces(err)) {
      expect(s).not.toContain(SECRET);
    }

    await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
    expect(ims.requests).toHaveLength(2);
    expect(consoleError).toHaveBeenCalledWith('Error while fetching token', expect.anything());
  },
);

const UNQUOTABLE_ERRORS: Array<[label: string, clientId: string, error: string]> = [
  ['a phrase', CLIENT_ID, 'invalid client_secret parameter'],
  ['markup', CLIENT_ID, '<b>denied</b>'],
  ['longer than an OAuth code', CLIENT_ID, 'x'.repeat(65)],
  ['the client secret itself', CLIENT_ID, SECRET],
  ['the client ID itself', 'lettersonlyclient', 'lettersonlyclient'],
];

test.each(UNQUOTABLE_ERRORS)(
  'an IMS error field that is %s is left out of the message',
  async (_label, clientId, error) => {
    ims.answer(400, { error });
    const provider = new ClientCredentialsProvider({ clientId, clientSecret: SECRET });

    const err: unknown = await provider.getAccessToken().catch((e: unknown) => e);

    expect((err as AudioVideoError).code).toBe('auth_failed');
    expect((err as AudioVideoError).message).not.toContain('IMS error');
    expect((err as AudioVideoError).message).not.toContain(error);
  },
);
