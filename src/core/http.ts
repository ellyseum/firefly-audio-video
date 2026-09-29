/**
 * The capability-neutral HTTP spine every request to `audio-video-api.adobe.io`
 * goes through — auth header injection, 429 backoff, and a one-shot
 * 401 auth-retry. `{@link HttpClient}` knows nothing about DGR, render bodies, or
 * any other capability: it moves JSON in, JSON (or nothing) out, generically
 * (`request<T>`), so the same spine serves render today and reframe/transcribe/
 * TTS/avatar/dub as fast-follow capabilities later. Render-specific shapes and
 * behavior live in `dgr/`, never here.
 */

import type { TokenProvider } from './auth.js';
import { AudioVideoError } from './errors.js';
import { redactError, redactUrl } from './redact.js';

/** @internal The default host every {@link HttpClient} targets unless {@link HttpClientOptions.host} overrides it. */
export const DEFAULT_HOST = 'https://audio-video-api.adobe.io';

/** @internal The default {@link HttpClientOptions.maxRetries} — how many 429 backoff retries a request gets. */
export const DEFAULT_MAX_RETRIES = 5;

/** Per-attempt request budget, enforced via `AbortSignal.timeout`. Not currently configurable. */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;

/** The exponential backoff's starting delay, before jitter, at `attempt === 0`. */
const BASE_BACKOFF_MS = 1_000;

/** The hard ceiling on any computed backoff delay, honored or exponential. */
const MAX_BACKOFF_MS = 60_000;

/** @internal The HTTP verbs this SDK's capabilities issue. Generic across every audio-video endpoint family. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * @internal Construction options for {@link HttpClient}.
 */
export interface HttpClientOptions {
  /** Base host relative paths resolve against. Defaults to {@link DEFAULT_HOST}. */
  host?: string;
  /** Sent as the `x-api-key` header on every request — the integration's client ID. */
  apiKey: string;
  /** Supplies the bearer token for `Authorization`, and is asked to force-refresh on a `401`. */
  tokenProvider: TokenProvider;
  /** Maximum number of 429 backoff retries before giving up. Defaults to {@link DEFAULT_MAX_RETRIES}. */
  maxRetries?: number;
}

/**
 * @internal Per-call options for {@link HttpClient.request}.
 */
export interface HttpRequestInit {
  /**
   * Combined, via `AbortSignal.any`, with this client's own per-attempt
   * `AbortSignal.timeout` — aborting this signal aborts the in-flight fetch
   * (and, if it fires during a 429 backoff wait, cancels that wait too)
   * regardless of which attempt is in progress; the request then rejects
   * with `code: 'cancelled'`.
   */
  signal?: AbortSignal;
  /**
   * Merged over the computed `Authorization` / `x-api-key` / `Accept` /
   * `Content-Type` headers — a caller-supplied value with the same name
   * wins, for the rare case a call needs to override one.
   */
  headers?: Record<string, string>;
  /**
   * Set when `path` came from a response body — a `202`'s `statusUrl` —
   * rather than from this SDK's caller: a path this client refuses (see
   * {@link HttpClient.request}) then rejects `invalid_response` instead of
   * `invalid_argument`.
   */
  fromResponse?: boolean;
}

/**
 * @internal The shape every successful {@link HttpClient.request} call resolves with.
 */
export interface HttpResponse<T> {
  /** The HTTP status code of the (eventually) successful response. */
  status: number;
  /** Every response header, by lowercase name — returned as-is, unredacted (see class docs). */
  headers: Record<string, string>;
  /** The parsed JSON response body, or `undefined` for an empty body. */
  body: T;
}

/**
 * Generic, capability-neutral HTTP client for the audio-video API:
 * injects auth on every request, retries `429` with backoff, and retries a
 * `401` once against a force-refreshed token before giving up. Used by every
 * capability's job/client layer (`dgr/`, and future siblings) — it has no
 * opinion about what `path`/`body`/`T` mean.
 *
 * **Response headers, returned in {@link HttpResponse.headers}, are NOT
 * redacted** — they are handed directly to the caller who explicitly asked
 * for them, not logged or thrown, so nothing has "left" the SDK in the sense
 * {@link redactUrl}/`redactValue` guard against. A thrown {@link AudioVideoError}
 * IS always redacted (see {@link HttpClient.request}'s `@throws`).
 *
 * @internal
 */
export class HttpClient {
  readonly #host: string;
  readonly #origin: string;
  readonly #apiKey: string;
  readonly #tokenProvider: TokenProvider;
  readonly #maxRetries: number;

  /**
   * @param opts - See {@link HttpClientOptions}.
   * @throws {@link AudioVideoError} `invalid_argument` when `opts.host` is not
   *   an http(s) URL, or carries user credentials (`https://user:pass@…`).
   */
  constructor(opts: HttpClientOptions) {
    this.#host = opts.host ?? DEFAULT_HOST;
    this.#origin = hostOrigin(this.#host);
    this.#apiKey = opts.apiKey;
    this.#tokenProvider = opts.tokenProvider;
    this.#maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /**
   * Issues one logical request, transparently retrying `429` (honoring its
   * `Retry-After` up to 60 seconds, else capped exponential backoff with
   * jitter) and, once, a `401` against a force-refreshed token (a stale-cache
   * safety net — see {@link TokenProvider.getAccessToken}'s `forceRefresh`).
   * `Retry-After` is read on a `429` only: every other response, a `202`
   * carrying one included, is returned or thrown at once.
   *
   * `path` may be a path relative to this client's host (`'/v1/status/abc'`)
   * or an already-absolute URL (e.g. a `statusUrl` the API returned) — both
   * resolve correctly via the native `URL` constructor.
   *
   * **Credentials never leave this client's origin.** A `path` that resolves
   * to a different origin than the host — another host or port, or `http:`
   * where the host is `https:` — or that carries user credentials, or does not
   * parse, is refused before a token is fetched or any header is attached:
   * `invalid_argument`, or `invalid_response` with
   * {@link HttpRequestInit.fromResponse}. Redirects are not followed, so a
   * `3xx` rejects as its own `http_3xx` rather than carrying the credentials
   * to wherever it points. A plain-`http` URL is accepted only when the host
   * itself is `http:`.
   *
   * The token is requested with `init.signal`, and an abort while it is being
   * fetched rejects `cancelled` at once, whether or not the provider honors
   * the signal itself.
   *
   * @typeParam T - The shape of the parsed JSON response body.
   * @param method - The HTTP verb to send.
   * @param path - A relative path or an absolute URL.
   * @param body - A JSON-serializable request body; omit for a bodyless request.
   * @param init - Per-call signal/header overrides; see {@link HttpRequestInit}.
   * @returns The status, headers, and parsed body of the eventual success response.
   * Every rejection is an {@link AudioVideoError}, and each one is redacted:
   * its `.message` names the URL through {@link redactUrl}, and a `.cause` is
   * a redacted copy of the original error, never the error itself.
   *
   * @throws {@link AudioVideoError} — `code: 'http_<status>'` — for any non-2xx
   *   response left after retries are exhausted, with `.items` holding the
   *   redacted response body.
   * @throws {@link AudioVideoError} — `code: 'cancelled'` — when `init.signal`
   *   aborts before the request settles, including during a backoff wait.
   * @throws {@link AudioVideoError} — `code: 'request_timeout'` — when one
   *   attempt runs past this client's own 30-second budget.
   * @throws {@link AudioVideoError} — `code: 'request_failed'` — when the
   *   request fails in transit before a complete response arrives: a DNS
   *   failure, a refused or reset connection.
   * @throws {@link AudioVideoError} — `code: 'auth_failed'` — when the token
   *   provider fails with anything but an {@link AudioVideoError}; one it
   *   rejects with passes through unchanged.
   */
  async request<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    init: HttpRequestInit = {},
  ): Promise<HttpResponse<T>> {
    const url = this.#resolve(path, init.fromResponse === true);
    let token = await this.#token(false, init.signal, url);
    let usedAuthRetry = false;

    for (let attempt = 0; ;) {
      const timeoutSignal = AbortSignal.timeout(DEFAULT_ATTEMPT_TIMEOUT_MS);
      const signal = init.signal ? AbortSignal.any([timeoutSignal, init.signal]) : timeoutSignal;

      try {
        const res = await fetch(url, {
          method,
          headers: buildRequestHeaders(token, this.#apiKey, body !== undefined, init.headers),
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'manual',
          signal,
        });

        if (res.status === 429 && attempt < this.#maxRetries) {
          await drainBody(res);
          await sleep(computeDelayMs(res.headers.get('retry-after'), attempt), init.signal);
          attempt += 1;
          continue;
        }

        if (res.status === 401 && !usedAuthRetry) {
          await drainBody(res);
          usedAuthRetry = true;
          token = await this.#token(true, init.signal, url);
          continue;
        }

        if (res.status >= 200 && res.status < 300) {
          return {
            status: res.status,
            headers: headersToRecord(res.headers),
            body: await parseBody<T>(res),
          };
        }

        throw await toAudioVideoError(res, url);
      } catch (error) {
        if (error instanceof AudioVideoError) throw error;
        throw requestFailure(error, url, init.signal, timeoutSignal);
      }
    }
  }

  /**
   * `path` resolved against this client's host — or, for a path that does
   * not parse, carries user credentials, or lands on another origin, an
   * `invalid_argument` error (`invalid_response` when `fromResponse`).
   */
  #resolve(path: string, fromResponse: boolean): URL {
    let url: URL | undefined;
    try {
      url = new URL(path, this.#host);
    } catch {
      url = undefined;
    }
    if (url?.origin === this.#origin && url.username === '' && url.password === '') return url;
    const problem =
      url === undefined
        ? 'is not a valid URL'
        : url.origin !== this.#origin
          ? `is on ${url.origin}, not ${this.#origin}`
          : 'carries user credentials';
    throw new AudioVideoError({
      message:
        `${fromResponse ? 'The URL the response named' : 'The request URL'} ${problem}: ` +
        'it was not requested, and no credentials were sent.',
      code: fromResponse ? 'invalid_response' : 'invalid_argument',
    });
  }

  /**
   * A token from the provider — force-refreshed when `forceRefresh` is set —
   * requested with `signal`. An abort, before the call or while it is
   * pending, rejects `cancelled`; a provider failure that is not already an
   * {@link AudioVideoError} becomes `auth_failed`, with a redacted copy of it
   * as `cause`.
   */
  async #token(forceRefresh: boolean, signal: AbortSignal | undefined, url: URL): Promise<string> {
    if (signal?.aborted) throw cancelledRequest(url, signal.reason);
    const provider = this.#tokenProvider;
    try {
      if (signal === undefined) {
        return await (forceRefresh
          ? provider.getAccessToken({ forceRefresh: true })
          : provider.getAccessToken());
      }
      const pending = provider.getAccessToken(forceRefresh ? { forceRefresh, signal } : { signal });
      return await untilAborted(pending, signal, url);
    } catch (error) {
      if (error instanceof AudioVideoError) throw error;
      throw new AudioVideoError({
        message: 'The token provider failed to supply an access token.',
        code: 'auth_failed',
        cause: redactError(error),
      });
    }
  }
}

/**
 * The origin every request of a client targets. The host must parse as an
 * http(s) URL without user credentials: those belong in the token provider,
 * and a URL carrying them would be sent to, and printed by, everything that
 * reads the request URL.
 */
function hostOrigin(host: string): string {
  let url: URL | undefined;
  try {
    url = new URL(host);
  } catch {
    url = undefined;
  }
  if (url === undefined || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new AudioVideoError({
      message: 'host must be an http(s) URL, e.g. https://audio-video-api.adobe.io.',
      code: 'invalid_argument',
    });
  }
  if (url.username !== '' || url.password !== '') {
    throw new AudioVideoError({
      message: 'host must not carry user credentials (user:password@).',
      code: 'invalid_argument',
    });
  }
  return url.origin;
}

/**
 * `pending`'s outcome, unless `signal` aborts first — then `cancelled`, while
 * `pending` settles on its own. The abort listener is removed once either
 * happens.
 */
function untilAborted<T>(pending: T | PromiseLike<T>, signal: AbortSignal, url: URL): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancelledRequest(url, signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(pending).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** The `cancelled` error for a request whose caller's signal aborted, with a redacted copy of `reason` as cause. */
function cancelledRequest(url: URL, reason: unknown): AudioVideoError {
  return new AudioVideoError({
    message: `Request to ${redactUrl(url.toString())} was cancelled.`,
    code: 'cancelled',
    cause: redactError(reason),
  });
}

/**
 * The {@link AudioVideoError} for an attempt that failed before a response
 * settled it: `cancelled` when the caller's signal aborted, `request_timeout`
 * when this client's own per-attempt timeout did, and `request_failed` for
 * any other transport failure. The `cause` is a redacted copy of `error`, and
 * a `request_failed` message names the innermost system error code (such as
 * `ECONNRESET`) when the cause chain carries one.
 */
function requestFailure(
  error: unknown,
  url: URL,
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): AudioVideoError {
  if (callerSignal?.aborted) return cancelledRequest(url, error);
  const target = redactUrl(url.toString());
  const cause = redactError(error);
  if (timeoutSignal.aborted) {
    return new AudioVideoError({
      message: `Request to ${target} did not complete within ${DEFAULT_ATTEMPT_TIMEOUT_MS / 1_000} seconds.`,
      code: 'request_timeout',
      cause,
    });
  }
  const systemCode = innermostCode(cause);
  return new AudioVideoError({
    message: `Request to ${target} failed before a complete response arrived${systemCode === undefined ? '' : ` (${systemCode})`}.`,
    code: 'request_failed',
    cause,
  });
}

/** The deepest string `code` along an error's `cause` chain, such as `ENOTFOUND`. */
function innermostCode(error: Error): string | undefined {
  let found: string | undefined;
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const { code } = current as Error & { code?: unknown };
    if (typeof code === 'string') found = code;
  }
  return found;
}

/** Builds the header set every attempt sends, before `extra` (caller headers) is merged on top. */
function buildRequestHeaders(
  token: string,
  apiKey: string,
  hasBody: boolean,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'x-api-key': apiKey,
    Accept: 'application/json',
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...extra,
  };
}

/** Flattens a fetch `Headers` object into a plain record, by lowercase name. */
function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * Reads a response body as text and, if non-empty, parses it as JSON — every
 * audio-video endpoint responds with JSON or an empty body (e.g. some `204`s),
 * never bare text, so a non-empty body that fails to parse is surfaced as-is
 * rather than silently swallowed.
 */
async function parseBody<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (text.length === 0) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/**
 * Discards a response body this client is not going to read — a `429`/`401`
 * that is about to be retried, so nothing here ever inspects its payload.
 * Releases the underlying connection back to its pool immediately rather
 * than leaving it open until the body is garbage-collected, which matters
 * exactly here: a shared credential hitting sustained `429`s can retry many
 * times per render. Never throws — discarding a body we were about to
 * ignore anyway must not abort the retry it precedes.
 */
async function drainBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Already discarding it — a failed cancel changes nothing we care about.
  }
}

/**
 * Resolves the delay before the next 429 retry: the wait `Retry-After` asks
 * for (see {@link retryAfterMs}), capped at {@link MAX_BACKOFF_MS}, else
 * {@link computeBackoffMs}. The cap also keeps every delay far below the
 * largest one `setTimeout` honors (2^31 − 1 ms), past which Node fires the
 * timer at once.
 */
function computeDelayMs(retryAfterHeader: string | null, attempt: number): number {
  const asked = retryAfterMs(retryAfterHeader);
  return asked === undefined ? computeBackoffMs(attempt) : Math.min(MAX_BACKOFF_MS, asked);
}

/**
 * The wait a `Retry-After` header asks for, in milliseconds: a finite,
 * non-negative number of seconds, or the time until an HTTP-date still in the
 * future. `undefined` for anything else — an absent or empty header, a
 * negative or non-finite number, an unparseable value, or a date that is not
 * in the future — which leaves the exponential backoff to decide.
 */
function retryAfterMs(header: string | null): number | undefined {
  const text = header?.trim() ?? '';
  if (text === '') return undefined;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const untilDate = Date.parse(text) - Date.now();
  return untilDate > 0 ? untilDate : undefined;
}

/**
 * Full-jitter exponential backoff: `attempt` doubles the base
 * delay each time, capped at {@link MAX_BACKOFF_MS} BEFORE jitter is applied,
 * and the delay actually used is a uniform random fraction of that capped
 * value. Capping before multiplying by `Math.random()` (rather than adding a
 * small jitter on top of an already-capped value) keeps the result *always*
 * strictly below {@link MAX_BACKOFF_MS} — including at high attempt counts,
 * where an additive scheme would otherwise degrade to a fixed, unjittered
 * 60s and reintroduce exactly the thundering-herd risk jitter exists to
 * avoid.
 */
function computeBackoffMs(attempt: number): number {
  const capped = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return Math.random() * capped;
}

/** `setTimeout`-backed delay, abortable via `signal` so a cancellation does not wait out a backoff. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason as Error);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Builds the {@link AudioVideoError} for a non-2xx response left after
 * retries are exhausted — status + a redacted URL (via {@link redactUrl}) in
 * the message, `x-request-id` when present, and the parsed (still-redacted —
 * `AudioVideoError`'s own constructor redacts `items` via `redactValue`)
 * response body.
 */
async function toAudioVideoError(res: Response, url: URL): Promise<AudioVideoError> {
  const body = await parseBody<unknown>(res);
  const requestId = res.headers.get('x-request-id') ?? undefined;
  return new AudioVideoError({
    message: `Request to ${redactUrl(url.toString())} failed with status ${res.status}.`,
    code: `http_${res.status}`,
    status: res.status,
    requestId,
    items: body === undefined ? undefined : Array.isArray(body) ? body : [body],
  });
}
