/**
 * IMS client-credentials authentication — reuses the official
 * `ServerToServerTokenProvider` from `@adobe/firefly-services-common-apis`
 * rather than hand-rolling the `ims/token/v3` exchange, and wraps it behind
 * this package's own {@link TokenProvider} seam so the HTTP client and the
 * top-level client never depend on a concrete auth implementation.
 */

import {
  ServerToServerTokenProvider,
  type ServerToServerAuthDetails,
} from '@adobe/firefly-services-common-apis';
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
 * minted token's claims give no expiry (neither `exp` nor `created_at` plus
 * `expires_in`; see {@link ClientCredentialsProvider}'s class docs: the
 * wrapped provider itself never reports the real `expires_in` it receives).
 * The preferred path reads the expiry directly from the token, so this
 * constant is a safety net, not the primary mechanism. Override via
 * {@link ClientCredentialsProviderOptions.tokenTtlMs} if a given
 * integration's actual token lifetime differs and its tokens carry no such
 * claims.
 *
 * @internal
 */
export const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Re-mint 60 seconds before the assumed expiry, by default. */
const DEFAULT_REFRESH_MARGIN_MS = 60_000;

/**
 * The shortest time a freshly minted token is served from the cache,
 * whatever its claims or the configured TTL say — so a token that arrives
 * already expired, or inside the refresh margin, costs one IMS request per
 * window rather than one per call.
 *
 * @internal
 */
export const MIN_TOKEN_REUSE_MS = 5_000;

/**
 * How long a mint waits for IMS before every caller waiting on it rejects
 * `auth_failed`. The wrapped provider's request carries no timeout or abort
 * signal of its own, so this bound is what stops a stalled IMS connection
 * from stalling every caller.
 *
 * @internal
 */
export const MINT_TIMEOUT_MS = 30_000;

/**
 * Tuning knobs for {@link ClientCredentialsProvider}'s own token cache.
 */
export interface ClientCredentialsProviderOptions {
  /**
   * How long a minted token is assumed valid, in milliseconds, when its own
   * claims give no expiry. Defaults to 24 hours.
   */
  tokenTtlMs?: number;
  /**
   * How long before the assumed expiry {@link ClientCredentialsProvider.getAccessToken}
   * re-mints rather than returning the cached token. Defaults to 60 seconds.
   * A token is still served for at least 5 seconds after it arrives.
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
 * Instead, every mint calls `authenticate()` on a fresh instance of the
 * wrapped provider, constructed with `autoRefresh: false` — its documented
 * shape for "the user should handle token refresh themselves" — so no two
 * mints ever share its state, and the cache lives here (tuned by
 * {@link ClientCredentialsProviderOptions}, never read from the wrapped
 * provider).
 *
 * **Every token is checked before it is returned or cached.** When IMS
 * refuses the credentials, `authenticate()` does not fail: it resolves
 * whatever the reply's `access_token` field held — `undefined` for an error
 * reply, and possibly `null`, a number, or `""`. Anything but a non-empty
 * string rejects `auth_failed` and never reaches the cache; the message
 * names IMS's OAuth `error` code when the reply carried one (only a plain
 * code that contains neither credential), and never the secret.
 *
 * **The expiry comes from the token's own claims.** IMS access tokens are
 * JWTs, so each freshly minted token's payload is decoded (its middle
 * segment, base64url → JSON). An `exp` claim (seconds since epoch) is used
 * when present; otherwise `created_at` plus `expires_in`, both in
 * milliseconds — the pair real IMS tokens carry, as numeric strings, in
 * place of `exp`. The wrapped provider's silence about `expires_in` (above)
 * therefore does not matter: this class reads the same fact off the token.
 * The configured TTL (24 hours unless overridden via
 * {@link ClientCredentialsProviderOptions.tokenTtlMs}) is only a fallback for
 * a token whose claims give no expiry; the decode never throws, so a
 * malformed or opaque token degrades to that fallback rather than breaking
 * authentication. A token is re-minted
 * {@link ClientCredentialsProviderOptions.refreshMarginMs} (60 seconds by
 * default) before its expiry, but never sooner than 5 seconds after it
 * arrived: a token that arrives already expired — a skewed clock, or a
 * lifetime shorter than the margin — costs one IMS request per 5 seconds,
 * not one per call. {@link GetAccessTokenOptions.forceRefresh} (which the
 * HTTP client sends after a `401`) still mints at once.
 *
 * Concurrent calls while a mint is in flight share the same underlying
 * request rather than each triggering their own — including a
 * {@link GetAccessTokenOptions.forceRefresh} call that arrives while another
 * mint (forced or cache-driven) is already in progress.
 *
 * **A mint is time-boxed to 30 seconds.** The wrapped provider's request has
 * no timeout of its own and cannot be aborted, so a mint IMS has not
 * answered within 30 seconds rejects every caller waiting on it with
 * `auth_failed`, and the next call starts a fresh mint. The abandoned
 * request runs on; its eventual answer is dropped, never cached.
 */
export class ClientCredentialsProvider implements TokenProvider {
  readonly #details: ServerToServerAuthDetails;
  readonly #tokenTtlMs: number;
  readonly #refreshMarginMs: number;
  #cachedToken: string | undefined;
  #refreshAt = 0;
  #inflight: Promise<string> | undefined;

  /**
   * @param credentials - The client ID/secret (and optional scope) to authenticate with.
   * @param options - Cache tuning; see {@link ClientCredentialsProviderOptions}.
   */
  constructor(credentials: ClientCredentials, options: ClientCredentialsProviderOptions = {}) {
    this.#details = {
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      scopes: credentials.scope ?? DEFAULT_SCOPE,
    };
    this.#tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.#refreshMarginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
  }

  /**
   * Returns the cached access token, re-minting through the wrapped provider
   * only once the cache is within
   * {@link ClientCredentialsProviderOptions.refreshMarginMs} of its assumed
   * expiry (and at least 5 seconds after the token arrived) — or
   * immediately, when {@link GetAccessTokenOptions.forceRefresh}
   * is set. A mint already in flight (cache-driven or forced) is shared by
   * every concurrent caller rather than triggering a second one.
   *
   * @param opts - See {@link GetAccessTokenOptions}.
   * @throws {@link AudioVideoError} with `code: 'auth_failed'` when IMS does
   *   not return a usable token — the message then names IMS's OAuth `error`
   *   code when it sent one — when the wrapped provider's `authenticate()`
   *   call fails outright, or when IMS has not answered within 30 seconds.
   *   The client secret is never included in the thrown error's message;
   *   when the wrapped provider threw, `.cause` carries its error for
   *   programmatic inspection and is excluded from every serialized form of
   *   {@link AudioVideoError} by construction.
   */
  async getAccessToken(opts: GetAccessTokenOptions = {}): Promise<string> {
    if (!opts.forceRefresh && this.#cachedToken !== undefined && Date.now() < this.#refreshAt) {
      return this.#cachedToken;
    }
    if (!this.#inflight) {
      this.#inflight = this.#mint().finally(() => {
        this.#inflight = undefined;
      });
    }
    return this.#inflight;
  }

  /**
   * One exchange, time-boxed to {@link MINT_TIMEOUT_MS}: the cache is written
   * only when IMS answers inside the bound. Past it, the promise rejects
   * `auth_failed`; the exchange itself cannot be stopped, so it runs on and
   * its eventual result is dropped.
   */
  #mint(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        reject(mintTimeoutError());
      }, MINT_TIMEOUT_MS);
      this.#exchange().then(
        ({ token, refreshAt }) => {
          clearTimeout(timer);
          if (timedOut) return;
          this.#cachedToken = token;
          this.#refreshAt = refreshAt;
          resolve(token);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * One IMS exchange on a fresh instance of the wrapped provider: the token
   * is checked, and its refresh point computed, without touching the cache.
   */
  async #exchange(): Promise<{ token: string; refreshAt: number }> {
    const vendor = new ServerToServerTokenProvider({ ...this.#details }, { autoRefresh: false });
    try {
      const token: unknown = await vendor.authenticate();
      if (typeof token !== 'string' || token === '') {
        throw refusedError(imsErrorCode(vendor, this.#details));
      }
      const arrivedAt = Date.now();
      const expiresAt = claimedExpiryMs(token) ?? arrivedAt + this.#tokenTtlMs;
      const refreshAt = Math.max(expiresAt - this.#refreshMarginMs, arrivedAt + MIN_TOKEN_REUSE_MS);
      return { token, refreshAt };
    } catch (cause) {
      if (cause instanceof AudioVideoError) throw cause;
      throw new AudioVideoError({
        message: 'Failed to obtain an access token via client-credentials authentication.',
        code: 'auth_failed',
        cause,
      });
    }
  }
}

/** The shape of an OAuth 2.0 `error` code: a short run of letters and underscores. */
const IMS_ERROR_CODE_RE = /^[A-Za-z_]{1,64}$/;

/**
 * IMS's OAuth `error` code from the reply the wrapped provider kept in its
 * `_tokenDetails` field, or `undefined` when there is none — or when the
 * value is not a plain code, or contains either credential, so the message
 * built from it can never echo one.
 */
function imsErrorCode(
  vendor: ServerToServerTokenProvider,
  details: ServerToServerAuthDetails,
): string | undefined {
  const reply: unknown = (vendor as unknown as { _tokenDetails?: unknown })._tokenDetails;
  const error =
    reply !== null && typeof reply === 'object' ? (reply as { error?: unknown }).error : undefined;
  if (typeof error !== 'string' || !IMS_ERROR_CODE_RE.test(error)) return undefined;
  return error.includes(details.clientSecret) || error.includes(details.clientId)
    ? undefined
    : error;
}

/** The `auth_failed` error every waiter on a mint receives once it outlives {@link MINT_TIMEOUT_MS}. */
function mintTimeoutError(): AudioVideoError {
  return new AudioVideoError({
    message: `IMS did not answer the token request within ${MINT_TIMEOUT_MS / 1_000} seconds.`,
    code: 'auth_failed',
  });
}

/** The `auth_failed` error for an IMS reply that carried no usable access token. */
function refusedError(imsError: string | undefined): AudioVideoError {
  const detail = imsError === undefined ? '' : ` (IMS error: ${imsError})`;
  return new AudioVideoError({
    message: `IMS did not return a usable access token${detail}; the client ID or secret was most likely refused.`,
    code: 'auth_failed',
  });
}

/**
 * Best-effort decode of when a JWT's own claims say it expires, as an epoch
 * millisecond timestamp — WITHOUT verifying the token's signature. This SDK
 * only reads the claims to size its own cache; it never treats the token as
 * trusted input on the strength of this decode, so signature verification
 * would add cost without adding safety here.
 *
 * `exp` (seconds since epoch) decides when it is a finite number; otherwise
 * `created_at` plus `expires_in`, both milliseconds, each a finite number or
 * a string of digits (IMS sends them as strings).
 *
 * Returns `undefined` for anything that is not a three-segment JWT, whose
 * payload segment does not decode to a JSON object, or whose claims give no
 * expiry by either rule. Never throws: an opaque, non-JWT access token — or
 * a malformed one — is a legitimate shape this SDK must tolerate, not an
 * error; `ClientCredentialsProvider`'s `#mint` falls back to its configured
 * TTL ({@link DEFAULT_TOKEN_TTL_MS} by default) whenever this returns
 * `undefined`.
 *
 * @param token - The raw access token, as returned by `authenticate()`.
 * @returns The claimed expiry in epoch milliseconds, or `undefined`.
 */
function claimedExpiryMs(token: string): number | undefined {
  const segments = token.split('.');
  const payload = segments.length === 3 ? segments[1] : undefined;
  if (!payload) return undefined;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (claims === null || typeof claims !== 'object') return undefined;
  const { exp, created_at: createdAt, expires_in: expiresIn } = claims as Record<string, unknown>;
  if (typeof exp === 'number' && Number.isFinite(exp)) return exp * 1000;
  const issuedAt = millisecondsClaim(createdAt);
  const lifetime = millisecondsClaim(expiresIn);
  return issuedAt === undefined || lifetime === undefined ? undefined : issuedAt + lifetime;
}

/** A millisecond claim: a finite number, or a string of digits as IMS sends it. */
function millisecondsClaim(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  return typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : undefined;
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
