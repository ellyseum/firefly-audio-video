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
import { brandClass } from './brand.js';
import { AudioVideoError } from './errors.js';
import { redactError } from './redact.js';

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
  /**
   * Stops this caller waiting for a token. {@link ClientCredentialsProvider}
   * rejects with {@link AudioVideoError} `code: 'cancelled'` (the signal's
   * `reason` as `.cause`) the moment it aborts — at once, without contacting
   * IMS, if it already has. A mint other callers are waiting on is never
   * cancelled: it runs on for them, and its token is cached like any other.
   */
  signal?: AbortSignal;
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
  /**
   * The integration's client ID. Also sent as the `x-api-key` header.
   * Surrounding whitespace is trimmed; it must not contain whitespace, a
   * control character, `&`, `=`, `+`, `%` or `#` (see
   * {@link ClientCredentialsProvider}).
   */
  clientId: string;
  /**
   * The integration's client secret. Never logged, thrown, or otherwise
   * surfaced. Surrounding whitespace is trimmed; it must not contain
   * whitespace, a control character, `&`, `=`, `+`, `%` or `#` (see
   * {@link ClientCredentialsProvider}).
   */
  clientSecret: string;
  /**
   * A single comma-joined scope string, e.g. `'openid,AdobeID,firefly_api,ff_apis'`
   * — `ServerToServerTokenProvider` (and the `ims/token/v3` endpoint it calls)
   * takes scopes this way, not as an array. Defaults to
   * `openid,AdobeID,firefly_api,ff_apis` when omitted. The same characters
   * as the client ID are refused.
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
 * How long each caller waits for IMS before rejecting `auth_failed`, and how
 * old a pending request may grow before the next caller starts a fresh one
 * instead of joining it. The wrapped provider's request carries no timeout or
 * abort signal of its own, so this bound is what stops a stalled IMS
 * connection from stalling every caller; the request itself runs on, and a
 * valid token it yields later is still cached unless the cache already holds
 * one that expires later.
 *
 * @internal
 */
export const MINT_TIMEOUT_MS = 30_000;

/**
 * How many IMS requests may be pending at once: one past its time-box that
 * never settled, and the fresh one started after it.
 */
const MAX_PENDING_MINTS = 2;

/** An IMS request still pending, and when it started. */
interface PendingMint {
  readonly promise: Promise<string>;
  readonly startedAt: number;
}

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
 * A call that needs a token while a mint is in flight waits on that mint
 * rather than starting its own — a {@link GetAccessTokenOptions.forceRefresh}
 * call included — as long as the mint is less than 30 seconds old.
 *
 * **Each caller waits at most 30 seconds, and a request that never settles
 * cannot block recovery.** The wrapped provider's request has no timeout of
 * its own and cannot be aborted, so a caller IMS has not answered within 30
 * seconds rejects `auth_failed`, and the request itself runs on. Once it is
 * 30 seconds old, the next call that needs a token starts a fresh request
 * instead of joining it; at most two are ever pending, and with two pending a
 * call waits on the newer one. Every valid token that arrives is cached,
 * however late — so even a consistently slow IMS ends up serving the calls
 * that follow — and when two arrive, the one that expires later is kept. A
 * cached token that is due for refresh, or that a
 * {@link GetAccessTokenOptions.forceRefresh} call asked to replace, gives way
 * to the next valid token whatever its expiry. A caller's
 * {@link GetAccessTokenOptions.signal} stops only that caller waiting: it
 * rejects `cancelled`, while the mint carries on for every other caller.
 *
 * **Credentials are checked at construction.** The wrapped provider builds
 * its form body without URL-encoding, so a client ID, secret or scope
 * containing `&`, `=`, `+`, `%` or `#`, whitespace or a control character
 * would reach IMS as a different value. The constructor trims surrounding
 * whitespace — the newline a value read from an environment file keeps —
 * and rejects anything else of that kind, and empty or non-string values,
 * with `invalid_argument` before any request is made, never quoting the
 * value.
 *
 * **Known upstream behaviour: the wrapped provider writes to
 * `console.error`.** It logs `"Error while fetching token"` with the error
 * whenever its request to IMS fails, IMS's reply is not JSON, or the reply
 * is a falsy JSON value such as `null` — even for a mint that has already
 * timed out. That output bypasses this SDK's logger, so `logging: false`
 * cannot silence it. A JSON refusal (an IMS error object) is not logged
 * this way; it surfaces only as the `auth_failed` rejection.
 */
export class ClientCredentialsProvider implements TokenProvider {
  readonly #details: ServerToServerAuthDetails;
  readonly #tokenTtlMs: number;
  readonly #refreshMarginMs: number;
  #cachedToken: string | undefined;
  /** When the cached token expires; `-Infinity` with none cached, or once a caller needs it replaced. */
  #cachedExpiresAt = Number.NEGATIVE_INFINITY;
  #refreshAt = 0;
  /** The IMS requests still pending, oldest first; never more than {@link MAX_PENDING_MINTS}. */
  readonly #pending: PendingMint[] = [];

  /**
   * @param credentials - The client ID/secret (and optional scope) to authenticate with.
   * @param options - Cache tuning; see {@link ClientCredentialsProviderOptions}.
   * @throws {@link AudioVideoError} with `code: 'invalid_argument'` when a
   *   credential is not a non-empty string, or contains a character the
   *   wrapped provider would send unencoded (`&`, `=`, `+`, `%`, `#`). The
   *   message names the field, never its value.
   */
  constructor(credentials: ClientCredentials, options: ClientCredentialsProviderOptions = {}) {
    if (credentials === null || typeof credentials !== 'object') {
      throw new AudioVideoError({
        message: 'ClientCredentialsProvider expects { clientId, clientSecret }.',
        code: 'invalid_argument',
      });
    }
    this.#details = {
      clientId: formSafe(credentials.clientId, 'clientId'),
      clientSecret: formSafe(credentials.clientSecret, 'clientSecret'),
      scopes: formSafe(credentials.scope ?? DEFAULT_SCOPE, 'scope'),
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
   * every caller that arrives while it is less than 30 seconds old; after
   * that a caller starts a fresh one, with at most two pending.
   *
   * @param opts - See {@link GetAccessTokenOptions}.
   * @throws {@link AudioVideoError} with `code: 'auth_failed'` when IMS does
   *   not return a usable token — the message then names IMS's OAuth `error`
   *   code when it sent one — when the wrapped provider's `authenticate()`
   *   call fails outright, or when IMS has not answered this caller within 30
   *   seconds.
   *   The client secret is never included in the thrown error's message;
   *   when the wrapped provider threw, `.cause` is a redacted copy of its
   *   error — never the error itself, which can hold a URL's signature and
   *   would print whole in Node's crash print for an unhandled rejection.
   * @throws {@link AudioVideoError} with `code: 'cancelled'` when
   *   `opts.signal` has aborted, or aborts before a token is available; a
   *   mint other callers are waiting on carries on for them.
   */
  async getAccessToken(opts: GetAccessTokenOptions = {}): Promise<string> {
    const { signal } = opts;
    if (signal?.aborted) throw cancelledError(signal);
    if (!opts.forceRefresh && this.#cachedToken !== undefined && Date.now() < this.#refreshAt) {
      return this.#cachedToken;
    }
    // The cached token is due for refresh or refused: the next valid token replaces it.
    this.#cachedExpiresAt = Number.NEGATIVE_INFINITY;
    const waited = withinMintTimeout(this.#mintToJoin());
    return signal === undefined ? waited : untilAborted(waited, signal);
  }

  /**
   * The mint a caller that needs a token waits on: the newest pending one
   * while it is inside its {@link MINT_TIMEOUT_MS} time-box, or once
   * {@link MAX_PENDING_MINTS} are pending; otherwise a fresh one, so a
   * request that never settles cannot hold every later caller.
   */
  #mintToJoin(): Promise<string> {
    const newest = this.#pending.at(-1);
    if (
      newest !== undefined &&
      (Date.now() - newest.startedAt < MINT_TIMEOUT_MS || this.#pending.length >= MAX_PENDING_MINTS)
    ) {
      return newest.promise;
    }
    return this.#mint();
  }

  /**
   * One exchange, pending until IMS answers or the request fails, however
   * long that takes. A valid token it yields is cached even when every caller
   * that was waiting on it has stopped — unless the cache holds one that
   * expires later and is not due for refresh. Each caller's own wait is
   * bounded separately, by {@link withinMintTimeout}.
   */
  #mint(): Promise<string> {
    const startedAt = Date.now();
    const promise: Promise<string> = this.#exchange()
      .then(({ token, expiresAt, refreshAt }) => {
        if (this.#cachedToken === undefined || expiresAt >= this.#cachedExpiresAt) {
          this.#cachedToken = token;
          this.#cachedExpiresAt = expiresAt;
          this.#refreshAt = refreshAt;
        }
        return token;
      })
      .finally(() => {
        const index = this.#pending.findIndex((mint) => mint.promise === promise);
        if (index !== -1) this.#pending.splice(index, 1);
      });
    this.#pending.push({ promise, startedAt });
    return promise;
  }

  /**
   * One IMS exchange on a fresh instance of the wrapped provider: the token
   * is checked, and its expiry and refresh point computed, without touching
   * the cache.
   */
  async #exchange(): Promise<{ token: string; expiresAt: number; refreshAt: number }> {
    const vendor = new ServerToServerTokenProvider({ ...this.#details }, { autoRefresh: false });
    try {
      const token: unknown = await vendor.authenticate();
      if (typeof token !== 'string' || token === '') {
        throw refusedError(imsErrorCode(vendor, this.#details));
      }
      const arrivedAt = Date.now();
      const expiresAt = claimedExpiryMs(token) ?? arrivedAt + this.#tokenTtlMs;
      const refreshAt = Math.max(expiresAt - this.#refreshMarginMs, arrivedAt + MIN_TOKEN_REUSE_MS);
      return { token, expiresAt, refreshAt };
    } catch (cause) {
      if (cause instanceof AudioVideoError) throw cause;
      throw new AudioVideoError({
        message: 'Failed to obtain an access token via client-credentials authentication.',
        code: 'auth_failed',
        cause: redactError(cause),
      });
    }
  }

  static {
    brandClass(this, 'ClientCredentialsProvider');
  }
}

/** The characters that change meaning in the form body the wrapped provider builds unencoded. */
const FORM_RESERVED_RE = /[&=+%#]/;

/** Whitespace or a control character, which no credential or scope list holds. */
const FORM_UNSAFE_RE = /[\s\p{Cc}]/u;

/**
 * `value` trimmed, once it is known to survive the wrapped provider's form
 * body: a non-empty string with no whitespace or control character inside
 * it and none of `&`, `=`, `+`, `%` or `#`, which the provider interpolates
 * without URL-encoding. Trimming makes a value read from the environment
 * with its trailing newline the same credential it is everywhere else. The
 * error names `field`, never the value.
 */
function formSafe(value: unknown, field: 'clientId' | 'clientSecret' | 'scope'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AudioVideoError({
      message: `${field} must be a non-empty string.`,
      code: 'invalid_argument',
    });
  }
  const text = value.trim();
  if (FORM_RESERVED_RE.test(text)) {
    throw new AudioVideoError({
      message:
        `${field} contains one of & = + % #. The official IMS token provider sends ` +
        'credentials without URL-encoding, so IMS would read a different value.',
      code: 'invalid_argument',
    });
  }
  if (FORM_UNSAFE_RE.test(text)) {
    throw new AudioVideoError({
      message:
        `${field} contains whitespace or a control character inside it, which IMS would read ` +
        `as a different value${field === 'scope' ? '; separate scopes with commas' : ''}.`,
      code: 'invalid_argument',
    });
  }
  return text;
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

/**
 * `promise`'s outcome, unless `signal` aborts first — then `cancelled`.
 * `promise` itself runs on for anyone else awaiting it, and the abort
 * listener is removed as soon as `promise` settles.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancelledError(signal));
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * `mint`'s outcome, unless {@link MINT_TIMEOUT_MS} passes first — then
 * `auth_failed`, while `mint` runs on for anyone else. The timer is cleared
 * as soon as `mint` settles, and the handler stays attached after a timeout,
 * so a mint that fails once nobody is waiting is never an unhandled
 * rejection.
 */
function withinMintTimeout(mint: Promise<string>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(mintTimeoutError()), MINT_TIMEOUT_MS);
    mint.then(
      (token) => {
        clearTimeout(timer);
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
 * The `cancelled` error a caller receives once its own signal stops its wait
 * for a token. `cause` is the signal's abort reason exactly as given, by
 * design: it is the caller's own value, handed back to the caller, and `cause`
 * never reaches a log record or a serialized form of the error.
 */
function cancelledError(signal: AbortSignal): AudioVideoError {
  return new AudioVideoError({
    message: 'Waiting for an access token was cancelled.',
    code: 'cancelled',
    cause: signal.reason,
  });
}

/** The `auth_failed` error a caller receives once it has waited {@link MINT_TIMEOUT_MS} for a mint. */
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
 * error; `ClientCredentialsProvider`'s `#exchange` falls back to its
 * configured TTL ({@link DEFAULT_TOKEN_TTL_MS} by default) whenever this
 * returns `undefined`.
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
 * @throws {@link AudioVideoError} `invalid_argument` for credentials the
 *   {@link ClientCredentialsProvider} constructor refuses.
 *
 * @internal
 */
export function resolveTokenProvider(input: TokenProvider | ClientCredentials): TokenProvider {
  return isTokenProvider(input) ? input : new ClientCredentialsProvider(input);
}

function isTokenProvider(input: TokenProvider | ClientCredentials): input is TokenProvider {
  return 'getAccessToken' in input && typeof input.getAccessToken === 'function';
}
