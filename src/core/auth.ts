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
 * Per-call tuning for {@link TokenProvider.getAccessToken}.
 */
export interface GetAccessTokenOptions {
  /**
   * Bypasses the provider's own cache and re-mints a fresh token even if the
   * cached one is not yet near its assumed expiry. The HTTP client's 401
   * auth-retry passes this — a `401` from the API is a stronger signal that
   * the cached token is stale than this provider's own clock-based guess.
   */
  forceRefresh?: boolean;
}

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
   * @param opts - See {@link GetAccessTokenOptions}.
   * @returns A non-expired IMS access token, ready to send as `Authorization: Bearer <token>`.
   */
  getAccessToken(opts?: GetAccessTokenOptions): Promise<string>;
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
   * takes scopes this way, not as an array. Defaults to
   * `openid,AdobeID,firefly_api,ff_apis` when omitted.
   */
  scope?: string;
}

/**
 * The default IMS scope set this SDK's audio/video (DGR) endpoints require,
 * as one comma-joined string.
 *
 * @internal
 */
export const DEFAULT_SCOPE = 'openid,AdobeID,firefly_api,ff_apis';

/**
 * The commonly documented lifetime of an IMS server-to-server access token —
 * the FALLBACK {@link ClientCredentialsProvider} refreshes against when a
 * minted token cannot be read as a JWT with an `exp` claim (see
 * {@link ClientCredentialsProvider}'s class docs: the wrapped provider itself
 * never reports the real `expires_in` it receives). The preferred path reads
 * the real expiry directly from the token, so this constant is a safety net,
 * not the primary mechanism. Override via
 * {@link ClientCredentialsProviderOptions.tokenTtlMs} if a given
 * integration's actual token lifetime differs and its tokens are not
 * decodable JWTs.
 *
 * @internal
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
   * provider re-mints. Defaults to 24 hours.
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
 * **The real expiry comes from the token itself, not a guess.** IMS access
 * tokens are JWTs, so each freshly minted token is decoded (its middle
 * segment, base64url → JSON) and its `exp` claim (seconds since epoch) is
 * used as the assumed expiry when present and numeric — the wrapped
 * provider's silence about `expires_in` (above) turns out not to matter,
 * because this class reads the same fact directly off the wire format. The
 * configured TTL (24 hours unless overridden via
 * {@link ClientCredentialsProviderOptions.tokenTtlMs}) is only a fallback for
 * a token that is not a decodable JWT, or has no `exp` claim; the decode
 * never throws, so a malformed or opaque token degrades to that fallback
 * rather than breaking authentication.
 *
 * Concurrent calls while a mint is in flight share the same underlying
 * request rather than each triggering their own — including a
 * {@link GetAccessTokenOptions.forceRefresh} call that arrives while another
 * mint (forced or cache-driven) is already in progress.
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
   * expiry — or immediately, when {@link GetAccessTokenOptions.forceRefresh}
   * is set. A mint already in flight (cache-driven or forced) is shared by
   * every concurrent caller rather than triggering a second one.
   *
   * @param opts - See {@link GetAccessTokenOptions}.
   * @throws {@link AudioVideoError} with `code: 'auth_failed'` if the wrapped
   *   provider's `authenticate()` call fails. The client secret is never
   *   included in the thrown error's message; `.cause` carries the original
   *   error for programmatic inspection and is excluded from every
   *   serialized form of {@link AudioVideoError} by construction.
   */
  async getAccessToken(opts: GetAccessTokenOptions = {}): Promise<string> {
    if (
      !opts.forceRefresh &&
      this.#cachedToken !== undefined &&
      Date.now() < this.#expiresAt - this.#refreshMarginMs
    ) {
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
    this.#expiresAt = decodeJwtExpiryMs(token) ?? Date.now() + this.#tokenTtlMs;
    return token;
  }
}

/**
 * Best-effort decode of a JWT's `exp` claim (seconds since epoch) into a
 * millisecond timestamp — WITHOUT verifying the token's signature. This SDK
 * only reads the claim to size its own cache; it never treats the token as
 * trusted input on the strength of this decode, so signature verification
 * would add cost without adding safety here.
 *
 * Returns `undefined` for anything that is not a three-segment JWT, whose
 * payload segment does not decode to JSON, or whose decoded payload has no
 * finite numeric `exp` (including a payload that parses to something other
 * than an object). Never throws: an opaque, non-JWT access token — or a
 * malformed one — is a legitimate shape this SDK must tolerate, not an
 * error; `ClientCredentialsProvider`'s `#mint` falls back to its configured
 * TTL ({@link DEFAULT_TOKEN_TTL_MS} by default) whenever this returns
 * `undefined`.
 *
 * @param token - The raw access token, as returned by `authenticate()`.
 * @returns The token's `exp` claim in epoch milliseconds, or `undefined`.
 */
function decodeJwtExpiryMs(token: string): number | undefined {
  const segments = token.split('.');
  const payload = segments.length === 3 ? segments[1] : undefined;
  if (!payload) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const exp =
      claims && typeof claims === 'object' ? (claims as { exp?: unknown }).exp : undefined;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
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
 *
 * @internal
 */
export function resolveTokenProvider(input: TokenProvider | ClientCredentials): TokenProvider {
  return isTokenProvider(input) ? input : new ClientCredentialsProvider(input);
}

function isTokenProvider(input: TokenProvider | ClientCredentials): input is TokenProvider {
  return 'getAccessToken' in input && typeof input.getAccessToken === 'function';
}
