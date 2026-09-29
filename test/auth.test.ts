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

const { ClientCredentialsProvider, DEFAULT_SCOPE, resolveTokenProvider } =
  await import('../src/core/auth.js');

beforeEach(() => {
  authenticateMock.mockReset();
  ctorMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

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
