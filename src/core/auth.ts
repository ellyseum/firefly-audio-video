/**
 * IMS client-credentials authentication — reuses the official
 * `ServerToServerTokenProvider` from `@adobe/firefly-services-common-apis`
 * rather than hand-rolling the `ims/token/v3` exchange, and wraps it behind
 * this package's own {@link TokenProvider} seam so the HTTP client and the
 * top-level client never depend on a concrete auth implementation.
 */

import { ServerToServerTokenProvider } from '@adobe/firefly-services-common-apis';
import { AudioVideoError } from './errors.js';

/**
 * The seam every authenticated call in this SDK depends on — the HTTP client
 * and the top-level client accept anything shaped like this, never a concrete
 * provider class, so a caller can substitute their own token source (a
 * shared org-wide credential, a test double, a different auth flow) without
 * this package knowing the difference.
 */
export interface TokenProvider {
  /**
   * Returns a valid bearer access token, minting or refreshing one if needed.
   * @returns A non-expired IMS access token, ready to send as `Authorization: Bearer <token>`.
   */
  getAccessToken(): Promise<string>;
}

/**
 * Server-to-server (IMS client-credentials) credentials for an Adobe Developer
 * Console integration. Pass these — or an already-built {@link TokenProvider}
 * — anywhere this SDK accepts authentication.
 */
export interface ClientCredentials {
  /** The integration's client ID. Also sent as the `x-api-key` header. */
  clientId: string;
  /** The integration's client secret. Never logged, thrown, or otherwise surfaced. */
  clientSecret: string;
  /**
   * A single comma-joined scope string, e.g. `'openid,AdobeID,firefly_api,ff_apis'`
   * — `ServerToServerTokenProvider` (and the `ims/token/v3` endpoint it calls)
   * takes scopes this way, not as an array. Defaults to {@link DEFAULT_SCOPE}
   * when omitted.
   */
  scope?: string;
}

/**
 * The default IMS scope set this SDK's audio/video (DGR) endpoints require,
 * as one comma-joined string.
 */
export const DEFAULT_SCOPE = 'openid,AdobeID,firefly_api,ff_apis';

/**
 * The commonly documented lifetime of an IMS server-to-server access token —
 * the assumed value {@link ClientCredentialsProvider} refreshes against,
 * since the wrapped provider does not report the real `expires_in` it
 * receives (see the class docs). Override via
 * {@link ClientCredentialsProviderOptions.tokenTtlMs} if a given
 * integration's actual token lifetime differs.
 */
export const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Re-mint 60 seconds before the assumed expiry, by default. */
const DEFAULT_REFRESH_MARGIN_MS = 60_000;

/**
 * Tuning knobs for {@link ClientCredentialsProvider}'s own token cache.
 */
export interface ClientCredentialsProviderOptions {
  /**
   * How long a minted token is assumed valid, in milliseconds, before this
   * provider re-mints. Defaults to {@link DEFAULT_TOKEN_TTL_MS}.
   */
  tokenTtlMs?: number;
  /**
   * How long before the assumed expiry {@link ClientCredentialsProvider.getAccessToken}
   * re-mints rather than returning the cached token. Defaults to 60 seconds.
   */
  refreshMarginMs?: number;
}

/**
 * {@link TokenProvider} backed by IMS client-credentials auth, via the
 * official `ServerToServerTokenProvider`.
 *
 * The wrapped class has no
 * `getAccessToken` method, and neither of its two public methods
 * (`getToken`/`authenticate`) exposes the token's real `expires_in` — the
 * value IMS returns is captured only in a private field. Its own
 * `getToken()` under `{ autoRefresh: true }` also does not re-authenticate
 * once a token has been minted and later expires (the internal check
 * requires *both* "no token yet" *and* "expired", but a minted token leaves
 * the first half permanently false), so this class never uses that path.
 * Instead, {@link ClientCredentialsProvider} constructs the wrapped provider
 * with `autoRefresh: false` — its documented shape for "the user should
 * handle token refresh themselves" — and calls `authenticate()` directly
 * whenever its own cache (tracked here, from
 * {@link ClientCredentialsProviderOptions}, never from the wrapped
 * provider's internal state) decides a fresh mint is due.
 *
 * Concurrent calls while a mint is in flight share the same underlying
 * request rather than each triggering their own.
 */
export class ClientCredentialsProvider implements TokenProvider {
  readonly #provider: ServerToServerTokenProvider;
  readonly #tokenTtlMs: number;
  readonly #refreshMarginMs: number;
  #cachedToken: string | undefined;
  #expiresAt = 0;
  #inflight: Promise<string> | undefined;

  /**
   * @param credentials - The client ID/secret (and optional scope) to authenticate with.
   * @param options - Cache tuning; see {@link ClientCredentialsProviderOptions}.
   */
  constructor(credentials: ClientCredentials, options: ClientCredentialsProviderOptions = {}) {
    this.#provider = new ServerToServerTokenProvider(
      {
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        scopes: credentials.scope ?? DEFAULT_SCOPE,
      },
      { autoRefresh: false },
    );
    this.#tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.#refreshMarginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
  }

  /**
   * Returns the cached access token, re-minting through the wrapped provider
   * only once the cache is within
   * {@link ClientCredentialsProviderOptions.refreshMarginMs} of its assumed
   * expiry. A mint already in flight is shared by every concurrent caller
   * rather than triggering a second one.
   *
   * @throws {@link AudioVideoError} with `code: 'auth_failed'` if the wrapped
   *   provider's `authenticate()` call fails. The client secret is never
   *   included in the thrown error's message; `.cause` carries the original
   *   error for programmatic inspection and is excluded from every
   *   serialized form of {@link AudioVideoError} by construction.
   */
  async getAccessToken(): Promise<string> {
    if (this.#cachedToken !== undefined && Date.now() < this.#expiresAt - this.#refreshMarginMs) {
      return this.#cachedToken;
    }
    if (!this.#inflight) {
      this.#inflight = this.#mint().finally(() => {
        this.#inflight = undefined;
      });
    }
    return this.#inflight;
  }

  async #mint(): Promise<string> {
    let token: string;
    try {
      token = await this.#provider.authenticate();
    } catch (cause) {
      throw new AudioVideoError({
        message: 'Failed to obtain an access token via client-credentials authentication.',
        code: 'auth_failed',
        cause,
      });
    }
    this.#cachedToken = token;
    this.#expiresAt = Date.now() + this.#tokenTtlMs;
    return token;
  }
}

/**
 * Normalizes anything this SDK accepts as authentication into a
 * {@link TokenProvider}: an already-built provider is returned as-is;
 * {@link ClientCredentials} are wrapped in a fresh
 * {@link ClientCredentialsProvider}. Used internally by the top-level client
 * so callers can pass either shape.
 *
 * @param input - A {@link TokenProvider} or {@link ClientCredentials}.
 * @returns `input` unchanged if it is already a {@link TokenProvider},
 *   otherwise a new {@link ClientCredentialsProvider} built from it.
 */
export function resolveTokenProvider(input: TokenProvider | ClientCredentials): TokenProvider {
  return isTokenProvider(input) ? input : new ClientCredentialsProvider(input);
}

function isTokenProvider(input: TokenProvider | ClientCredentials): input is TokenProvider {
  return 'getAccessToken' in input && typeof input.getAccessToken === 'function';
}
