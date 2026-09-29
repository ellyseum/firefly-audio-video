import { inspect } from 'node:util';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AudioVideoError } from '../src/core/errors.js';

const { authenticateMock, ctorMock } = vi.hoisted(() => ({
  authenticateMock: vi.fn<() => Promise<string>>(),
  ctorMock: vi.fn(),
}));

vi.mock('@adobe/firefly-services-common-apis', () => ({
  ServerToServerTokenProvider: class {
    constructor(...args: unknown[]) {
      ctorMock(...args);
    }
    authenticate = authenticateMock;
  },
}));

const { ClientCredentialsProvider, DEFAULT_SCOPE, DEFAULT_TOKEN_TTL_MS, resolveTokenProvider } =
  await import('../src/core/auth.js');

beforeEach(() => {
  authenticateMock.mockReset();
  ctorMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

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
  authenticateMock.mockResolvedValueOnce('TOKEN_1');
  const provider = resolveTokenProvider({ clientId: 'id', clientSecret: 'secret' });
  expect(provider).toBeInstanceOf(ClientCredentialsProvider);
  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_1');
});

// --- ClientCredentialsProvider construction / scope ---------------------------

test('defaults to DEFAULT_SCOPE, comma-joined, when scope is omitted', () => {
  new ClientCredentialsProvider({ clientId: 'id', clientSecret: 'secret' });
  const [details] = ctorMock.mock.calls[0]!;
  expect(details).toEqual({ clientId: 'id', clientSecret: 'secret', scopes: DEFAULT_SCOPE });
  expect(DEFAULT_SCOPE).toBe('openid,AdobeID,firefly_api,ff_apis');
});

test('passes a custom scope straight through unchanged', () => {
  new ClientCredentialsProvider({ clientId: 'id', clientSecret: 'secret', scope: 'openid,foo' });
  const [details] = ctorMock.mock.calls[0]!;
  expect(details).toMatchObject({ scopes: 'openid,foo' });
});

// --- caching -------------------------------------------------------------------

test('caches the token: two calls before expiry mint only once', async () => {
  authenticateMock.mockResolvedValueOnce('TOKEN_1').mockResolvedValueOnce('TOKEN_2');
  const provider = new ClientCredentialsProvider(
    { clientId: 'id', clientSecret: 'secret' },
    { tokenTtlMs: 10_000, refreshMarginMs: 1_000 },
  );

  const a = await provider.getAccessToken();
  const b = await provider.getAccessToken();

  expect(a).toBe('TOKEN_1');
  expect(b).toBe('TOKEN_1');
  expect(authenticateMock).toHaveBeenCalledTimes(1);
});

test('re-mints once the cached token nears its assumed expiry', async () => {
  vi.useFakeTimers();
  authenticateMock.mockResolvedValueOnce('TOKEN_1').mockResolvedValueOnce('TOKEN_2');
  const provider = new ClientCredentialsProvider(
    { clientId: 'id', clientSecret: 'secret' },
    { tokenTtlMs: 10_000, refreshMarginMs: 1_000 },
  );

  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_1');

  // 9_500ms elapsed: within the 1_000ms refresh margin of the 10_000ms assumed TTL.
  await vi.advanceTimersByTimeAsync(9_500);

  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
  expect(authenticateMock).toHaveBeenCalledTimes(2);
});

test('concurrent getAccessToken calls while minting share one underlying request', async () => {
  let resolveAuth!: (value: string) => void;
  authenticateMock.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        resolveAuth = resolve;
      }),
  );
  const provider = new ClientCredentialsProvider({ clientId: 'id', clientSecret: 'secret' });

  const p1 = provider.getAccessToken();
  const p2 = provider.getAccessToken();
  resolveAuth('TOKEN_1');

  await expect(p1).resolves.toBe('TOKEN_1');
  await expect(p2).resolves.toBe('TOKEN_1');
  expect(authenticateMock).toHaveBeenCalledTimes(1);
});

// --- forceRefresh --------------------------------------------------------------

test('forceRefresh bypasses the cache and re-mints even when not near expiry', async () => {
  authenticateMock.mockResolvedValueOnce('TOKEN_1').mockResolvedValueOnce('TOKEN_2');
  const provider = new ClientCredentialsProvider({ clientId: 'id', clientSecret: 'secret' });

  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_1');
  await expect(provider.getAccessToken({ forceRefresh: true })).resolves.toBe('TOKEN_2');
  expect(authenticateMock).toHaveBeenCalledTimes(2);

  // the forced mint is now the cached token — a plain call returns it without minting again.
  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
  expect(authenticateMock).toHaveBeenCalledTimes(2);
});

test('a forceRefresh call that arrives while a mint is already in flight shares it', async () => {
  let resolveAuth!: (value: string) => void;
  authenticateMock.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        resolveAuth = resolve;
      }),
  );
  const provider = new ClientCredentialsProvider({ clientId: 'id', clientSecret: 'secret' });

  const p1 = provider.getAccessToken();
  const p2 = provider.getAccessToken({ forceRefresh: true });
  resolveAuth('TOKEN_1');

  await expect(p1).resolves.toBe('TOKEN_1');
  await expect(p2).resolves.toBe('TOKEN_1');
  expect(authenticateMock).toHaveBeenCalledTimes(1);
});

// --- JWT exp decode --------------------------------------------------------------

test('a decodable JWT exp claim drives the cache expiry, not the assumed TTL', async () => {
  vi.useFakeTimers();
  const expSeconds = Math.floor(Date.now() / 1000) + 120; // 2 minutes from mint time.
  const jwt = fakeJwt({ exp: expSeconds });
  authenticateMock.mockResolvedValueOnce(jwt).mockResolvedValueOnce('TOKEN_2');
  // Default options: if DEFAULT_TOKEN_TTL_MS (24h) were driving the cache instead of the
  // JWT's own exp, neither advance below would come anywhere near a re-mint.
  const provider = new ClientCredentialsProvider({ clientId: 'id', clientSecret: 'secret' });

  await expect(provider.getAccessToken()).resolves.toBe(jwt);

  // 59s elapsed: still inside the 120s JWT lifetime minus the default 60s refresh margin.
  await vi.advanceTimersByTimeAsync(59_000);
  await expect(provider.getAccessToken()).resolves.toBe(jwt);
  expect(authenticateMock).toHaveBeenCalledTimes(1);

  // past the 60s-before-expiry boundary (120s - 60s = 60s elapsed): re-mints.
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
  expect(authenticateMock).toHaveBeenCalledTimes(2);
});

test('a JWT with no exp claim falls back to the configured TTL', async () => {
  vi.useFakeTimers();
  const jwt = fakeJwt({ sub: 'someone' });
  authenticateMock.mockResolvedValueOnce(jwt).mockResolvedValueOnce('TOKEN_2');
  const provider = new ClientCredentialsProvider(
    { clientId: 'id', clientSecret: 'secret' },
    { tokenTtlMs: 10_000, refreshMarginMs: 1_000 },
  );

  await expect(provider.getAccessToken()).resolves.toBe(jwt);
  await vi.advanceTimersByTimeAsync(9_500);
  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
  expect(authenticateMock).toHaveBeenCalledTimes(2);
});

test('a JWT whose payload decodes to a non-object JSON value falls back to the configured TTL', async () => {
  vi.useFakeTimers();
  // A syntactically valid JWT (three segments, valid base64url/JSON payload) whose
  // payload is a bare number rather than a claims object — `42.exp` is not a thing.
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from('42').toString('base64url');
  const jwt = `${header}.${payload}.sig`;
  authenticateMock.mockResolvedValueOnce(jwt).mockResolvedValueOnce('TOKEN_2');
  const provider = new ClientCredentialsProvider(
    { clientId: 'id', clientSecret: 'secret' },
    { tokenTtlMs: 10_000, refreshMarginMs: 1_000 },
  );

  await expect(provider.getAccessToken()).resolves.toBe(jwt);
  await vi.advanceTimersByTimeAsync(9_500);
  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
  expect(authenticateMock).toHaveBeenCalledTimes(2);
});

test('a JWT-shaped token with an undecodable payload never throws and falls back to the configured TTL', async () => {
  vi.useFakeTimers();
  authenticateMock
    .mockResolvedValueOnce('a.not-valid-base64url-json.c')
    .mockResolvedValueOnce('TOKEN_2');
  const provider = new ClientCredentialsProvider(
    { clientId: 'id', clientSecret: 'secret' },
    { tokenTtlMs: 10_000, refreshMarginMs: 1_000 },
  );

  await expect(provider.getAccessToken()).resolves.toBe('a.not-valid-base64url-json.c');
  await vi.advanceTimersByTimeAsync(9_500);
  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
  expect(authenticateMock).toHaveBeenCalledTimes(2);
});

test('a non-JWT opaque token falls back to DEFAULT_TOKEN_TTL_MS when no tokenTtlMs is configured', async () => {
  vi.useFakeTimers();
  authenticateMock.mockResolvedValueOnce('OPAQUE_TOKEN_NOT_A_JWT').mockResolvedValueOnce('TOKEN_2');
  const provider = new ClientCredentialsProvider({ clientId: 'id', clientSecret: 'secret' });

  await expect(provider.getAccessToken()).resolves.toBe('OPAQUE_TOKEN_NOT_A_JWT');

  // Just inside DEFAULT_TOKEN_TTL_MS (24h) minus the default 60s refresh margin: no re-mint.
  await vi.advanceTimersByTimeAsync(DEFAULT_TOKEN_TTL_MS - 60_000 - 1_000);
  await expect(provider.getAccessToken()).resolves.toBe('OPAQUE_TOKEN_NOT_A_JWT');
  expect(authenticateMock).toHaveBeenCalledTimes(1);

  // past that boundary: re-mints.
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(provider.getAccessToken()).resolves.toBe('TOKEN_2');
  expect(authenticateMock).toHaveBeenCalledTimes(2);
});

// --- failure -------------------------------------------------------------------

test('a failing mint throws AudioVideoError with a stable code and never leaks the secret', async () => {
  authenticateMock.mockRejectedValueOnce(new Error('network exploded'));
  const provider = new ClientCredentialsProvider({
    clientId: 'id',
    clientSecret: 'TOP_SECRET_VALUE',
  });

  const err: unknown = await provider.getAccessToken().catch((e: unknown) => e);

  expect(err).toBeInstanceOf(AudioVideoError);
  expect((err as AudioVideoError).code).toBe('auth_failed');
  expect((err as AudioVideoError).cause).toBeInstanceOf(Error);

  const serialized = [JSON.stringify(err), String(err), inspect(err)];
  for (const s of serialized) {
    expect(s).not.toContain('TOP_SECRET_VALUE');
  }
});
