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
import { redactUrl } from './redact.js';

/** The default host every {@link HttpClient} targets unless {@link HttpClientOptions.host} overrides it. */
export const DEFAULT_HOST = 'https://audio-video-api.adobe.io';

/** The default {@link HttpClientOptions.maxRetries} — how many 429 backoff retries a request gets. */
export const DEFAULT_MAX_RETRIES = 5;

/** Per-attempt request budget, enforced via `AbortSignal.timeout`. Not currently configurable. */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;

/** The exponential backoff's starting delay, before jitter, at `attempt === 0`. */
const BASE_BACKOFF_MS = 1_000;

/** The hard ceiling on any computed backoff delay, honored or exponential. */
const MAX_BACKOFF_MS = 60_000;

/** The HTTP verbs this SDK's capabilities issue. Generic across every audio-video endpoint family. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Construction options for {@link HttpClient}.
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
 * Per-call options for {@link HttpClient.request}.
 */
export interface HttpRequestInit {
  /**
   * Combined, via `AbortSignal.any`, with this client's own per-attempt
   * `AbortSignal.timeout` — aborting this signal aborts the in-flight fetch
   * (and, if it fires during a 429 backoff wait, cancels that wait too)
   * regardless of which attempt is in progress.
   */
  signal?: AbortSignal;
  /**
   * Merged over the computed `Authorization` / `x-api-key` / `Accept` /
   * `Content-Type` headers — a caller-supplied value with the same name
   * wins, for the rare case a call needs to override one.
   */
  headers?: Record<string, string>;
}

/**
 * The shape every successful {@link HttpClient.request} call resolves with.
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
 */
export class HttpClient {
  readonly #host: string;
  readonly #apiKey: string;
  readonly #tokenProvider: TokenProvider;
  readonly #maxRetries: number;

  /**
   * @param opts - See {@link HttpClientOptions}.
   */
  constructor(opts: HttpClientOptions) {
    this.#host = opts.host ?? DEFAULT_HOST;
    this.#apiKey = opts.apiKey;
    this.#tokenProvider = opts.tokenProvider;
    this.#maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /**
   * Issues one logical request, transparently retrying `429` (honoring
   * `Retry-After`, else capped exponential backoff with jitter)
   * and, once, a `401` against a force-refreshed token (a stale-cache safety
   * net — see {@link TokenProvider.getAccessToken}'s `forceRefresh`).
   *
   * `path` may be a path relative to this client's host (`'/v1/status/abc'`)
   * or an already-absolute URL (e.g. a `statusUrl` the API returned) — both
   * resolve correctly via the native `URL` constructor.
   *
   * @typeParam T - The shape of the parsed JSON response body.
   * @param method - The HTTP verb to send.
   * @param path - A relative path or an absolute URL.
   * @param body - A JSON-serializable request body; omit for a bodyless request.
   * @param init - Per-call signal/header overrides; see {@link HttpRequestInit}.
   * @returns The status, headers, and parsed body of the eventual success response.
   * @throws {@link AudioVideoError} — `code: 'http_<status>'` — for any non-2xx
   *   response left after retries are exhausted. Its `.message` and `.items`
   *   (the redacted response body) are built via {@link redactUrl}/`redactValue`
   *   so a presigned URL's SAS params or a leaked secret never reach it.
   * @throws Whatever `fetch` rejects with when `init.signal` (or the caller's
   *   own signal) aborts before a response is received — this SDK does not
   *   wrap an abort into {@link AudioVideoError}, since no response, and so no
   *   status, ever existed to build one from.
   */
  async request<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    init: HttpRequestInit = {},
  ): Promise<HttpResponse<T>> {
    const url = new URL(path, this.#host);
    let token = await this.#tokenProvider.getAccessToken();
    let usedAuthRetry = false;

    for (let attempt = 0; ;) {
      const timeoutSignal = AbortSignal.timeout(DEFAULT_ATTEMPT_TIMEOUT_MS);
      const signal = init.signal ? AbortSignal.any([timeoutSignal, init.signal]) : timeoutSignal;

      const res = await fetch(url, {
        method,
        headers: buildRequestHeaders(token, this.#apiKey, body !== undefined, init.headers),
        body: body === undefined ? undefined : JSON.stringify(body),
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
        token = await this.#tokenProvider.getAccessToken({ forceRefresh: true });
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
    }
  }
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
 * Resolves the delay before the next 429 retry: `Retry-After` (seconds, or an
 * HTTP-date) when the response sent one, else {@link computeBackoffMs}. A
 * `Retry-After` that is neither a valid non-negative integer nor a parseable
 * date falls through to the exponential path rather than stalling forever.
 */
function computeDelayMs(retryAfterHeader: string | null, attempt: number): number {
  if (retryAfterHeader !== null) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const dateMs = Date.parse(retryAfterHeader);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  return computeBackoffMs(attempt);
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
