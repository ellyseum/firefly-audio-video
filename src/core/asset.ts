/**
 * The capability-neutral handle every audio-video output resolves to, whatever
 * capability produced it. Wraps a presigned read URL with the ways of
 * consuming it — free URL access, an in-memory buffer, a pipeable stream, or a
 * direct-to-disk save — plus the timing derived from the job that produced it.
 * Every download is resumable: a body cut off mid-transfer continues with an
 * HTTP `Range` request for the bytes still missing, rather than failing the
 * whole transfer of what can be a multi-gigabyte master.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { AudioVideoError } from './errors.js';
import type { JobMeta } from './job.js';
import { redactUrl, redactValue } from './redact.js';
import { delay, linkSignals } from './signals.js';

/**
 * The subset of the global `fetch` function {@link Asset} needs: called with
 * a URL and an options object carrying a `signal` that aborts when the
 * caller's does — plus, on a request that resumes an interrupted download,
 * its `Range` and `If-Range` headers — and resolving with a `Response`.
 * Narrower than `typeof fetch` so a test can inject a stub matching this
 * exact shape.
 */
type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<Response>;

/** How many times an interrupted download re-requests the asset unless told otherwise. */
const DEFAULT_RETRIES = 3;

/** The longest the first retry waits, before jitter; each later retry doubles it. */
const RETRY_BACKOFF_BASE_MS = 250;

/** The longest any retry waits, however many came before it. */
const RETRY_BACKOFF_CAP_MS = 2_000;

/** Why a content-encoded download cannot continue where it stopped. */
const CONTENT_ENCODED =
  'the response is content-encoded, so no byte offset into it can be requested';

/** Construction options for {@link Asset}. */
export interface AssetOptions {
  /** The presigned read URL naming the asset — see {@link Asset.url}. */
  url: string;
  /** Timing derived from the job that produced the asset — see {@link Asset.meta}. */
  meta: JobMeta;
  /**
   * Replaces the fetch every accessor issues its requests through. Defaults to
   * `globalThis.fetch`; a test drives this with an undici `MockAgent`-backed
   * stub, or a hand-built `Response`, instead of mutating the global dispatcher.
   */
  fetch?: FetchLike;
}

/** Options shared by {@link Asset.buffer}, {@link Asset.stream}, and {@link Asset.save}. */
export interface AssetReadOptions {
  /**
   * Aborts the underlying fetch, an in-progress body read, or the wait before
   * a retry, when it fires. An abort rejects — or, on {@link Asset.stream},
   * emits — an {@link AudioVideoError} `code: 'cancelled'`, rather than
   * whatever error shape the platform's own abort produces.
   */
  signal?: AbortSignal;
  /**
   * How many times one download may re-request the asset after its body is
   * cut off mid-transfer — a connection reset, a premature close. Each retry
   * waits a short jittered backoff (never more than two seconds), then asks
   * for the bytes still missing with `Range: bytes=<received>-`, made
   * conditional by `If-Range` on the asset being unchanged (its `ETag`, else
   * its `Last-Modified`). Only a `206` whose `Content-Range` starts exactly
   * where the download stopped is appended; {@link Asset.stream} and
   * {@link Asset.save} describe what happens when the server cannot resume. A
   * status on a retry other than `408`, `429` or a `5xx` fails the download at
   * once. Defaults to `3`; `0` turns resuming off, so the first interruption
   * fails the download.
   */
  retries?: number;
}

/** The redacted, JSON-safe shape {@link Asset.toJSON} produces. */
export interface AssetJSON {
  /** {@link Asset.url}, with any SAS/SigV4 signing parameters removed. */
  url: string;
  meta: JobMeta;
}

/**
 * A finished audio-video output: a presigned read URL plus every way of
 * consuming it. `.url` is free — nothing is fetched until {@link Asset.buffer},
 * {@link Asset.stream}, or {@link Asset.save} is called, and each of those issues its own
 * request rather than sharing one response across calls. Each download
 * resumes a body cut off mid-transfer — see {@link AssetReadOptions.retries}.
 *
 * `.url` is deliberately unredacted — it is the working handle a caller passes
 * to `fetch`, a download manager, or another service, and redacting it would
 * make it useless for that. Redaction applies everywhere this asset might
 * instead be *logged or displayed*: {@link Asset.toJSON}, {@link Asset.toString}, and
 * `console.log` (via the `util.inspect` custom hook) all report a scrubbed URL.
 *
 * @example
 * ```ts
 * const asset = await render(spec);
 * asset.url;                      // presigned read URL — free, nothing downloaded
 * await asset.buffer();           // in memory (small files)
 * asset.stream();                 // Node Readable, pipe anywhere; resumes a dropped connection
 * await asset.save('./out.mov');  // stream to disk, no full buffer
 * asset.meta.totalMs;             // derived timing from the job that produced it
 * ```
 */
export class Asset {
  readonly #url: string;
  /** Timing derived from the job that produced this asset. */
  readonly meta: JobMeta;
  readonly #fetch: FetchLike;

  /**
   * @param options - See {@link AssetOptions}.
   */
  constructor(options: AssetOptions) {
    this.#url = options.url;
    this.meta = options.meta;
    this.#fetch = options.fetch ?? (globalThis.fetch as FetchLike);
  }

  /**
   * The presigned read URL naming this asset — unredacted; see the class
   * docs. A get-only accessor over a private field rather than a plain
   * public field, so it never becomes an enumerable own property: spread,
   * `Object.keys`, `Object.assign`, `structuredClone`, `console.dir`, and
   * `console.table` all skip it, while `asset.url` itself is unaffected.
   */
  get url(): string {
    return this.#url;
  }

  /**
   * Fetches the whole asset into memory. Fine for small files; a large render
   * (a multi-gigabyte ProRes master, say) should use {@link Asset.stream} or
   * {@link Asset.save} instead, neither of which buffers the full body. A body
   * cut off mid-transfer resumes as {@link AssetReadOptions.retries}
   * describes; a server that cannot resume fails the read, exactly as it ends
   * {@link Asset.stream}.
   *
   * @param options - See {@link AssetReadOptions}.
   * @returns The asset's bytes.
   * @throws {@link AudioVideoError} — `code: 'asset_fetch_failed'` — for a
   *   non-2xx response, a download that could not be resumed or ran out of
   *   retries, or any other fetch failure (a malformed URL, a DNS failure),
   *   always with a redacted URL and a sanitized `cause` in place of the raw
   *   error.
   * @throws {@link AudioVideoError} — `code: 'cancelled'` — when
   *   `options.signal` aborts before or during the read.
   * @throws {@link AudioVideoError} — `code: 'invalid_argument'` — when
   *   `options.retries` is not a non-negative integer.
   */
  async buffer(options: AssetReadOptions = {}): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.#download(readPlan(options))) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  /**
   * A byte-mode Node `Readable` over the asset's bytes (`readableObjectMode`
   * is `false`, so `read(n)` returns exactly `n` bytes once that much has
   * buffered), for piping anywhere (a write stream, a transform, another
   * request body) without holding the whole file in memory. Lazy: the
   * underlying fetch does not start until the stream is first read — via
   * `.pipe()`, a `'data'` listener, `.resume()`, or an explicit `.read()` —
   * so a `stream()` call that is never consumed issues no request at all. A
   * fetch failure — a non-2xx response, a malformed URL, a DNS failure, an
   * abort — surfaces as an `'error'` event carrying the same
   * {@link AudioVideoError} {@link Asset.buffer} would throw, never as an
   * unhandled rejection. Destroying the stream — directly, or through
   * `pipeline()` when the destination fails — ends the download at once: a
   * request in flight is aborted, a wait before a retry is cut short, and no
   * further request is made.
   *
   * Range-backed: a body cut off mid-transfer continues from the next byte as
   * {@link AssetReadOptions.retries} describes, so the reader sees one
   * unbroken byte sequence. Bytes already emitted cannot be taken back, so a
   * server that cannot resume — it answers the `Range` request with `200`
   * (the asset changed, or it ignores ranges), with `416`, or with a
   * `Content-Range` that does not continue where the stream stopped — ends the
   * stream with an `asset_fetch_failed` error saying the download could not be
   * resumed, rather than repeating bytes from the start.
   *
   * @param options - See {@link AssetReadOptions}.
   * @returns A readable byte stream over the asset's bytes.
   * @throws {@link AudioVideoError} — `code: 'invalid_argument'` — at once,
   *   when `options.retries` is not a non-negative integer.
   */
  stream(options: AssetReadOptions = {}): Readable {
    const plan = readPlan(options);
    const destroyed = new AbortController();
    const link = linkSignals(
      plan.signal === undefined ? [destroyed.signal] : [plan.signal, destroyed.signal],
    );
    const bytes = Readable.from(this.#download({ ...plan, signal: link.signal }), {
      objectMode: false,
    });
    // Readable.from's own destroy asks the generator to return, which takes
    // effect only at its next yield: after a backoff, and after the request
    // that follows it. Aborting the download here ends either at once.
    const destroyDownload = bytes._destroy.bind(bytes);
    bytes._destroy = (error, callback) => {
      destroyed.abort(error ?? new Error('The stream was destroyed.'));
      destroyDownload(error, callback);
    };
    bytes.once('close', link.release);
    return bytes;
  }

  /**
   * Streams the asset directly to `path`, creating any missing parent
   * directories first. Never buffers the whole file in memory — bytes reach
   * disk as they arrive over the network, not after the response completes. A
   * fetch failure — a non-2xx response, a malformed URL, a DNS failure, an
   * abort — rejects with the same {@link AudioVideoError} {@link Asset.buffer}
   * would throw. The download lands in a temporary file beside `path` first and
   * is moved into place with a single rename once it completes; on any
   * failure — the response status, a transport error, an abort, or a
   * directory, write or rename error — the temp file is removed and `path` is
   * left exactly as it was beforehand: absent stays absent, an existing file
   * stays byte-identical.
   *
   * A body cut off mid-transfer resumes as {@link AssetReadOptions.retries}
   * describes. When the server cannot resume — it answers the `Range` request
   * with `200`, with `416`, or with a `Content-Range` that does not continue
   * where the download stopped — the download starts over from byte zero in a
   * fresh temp file, the partial one deleted, within the same retry budget.
   *
   * @param path - The destination file path.
   * @param options - See {@link AssetReadOptions}.
   * @throws {@link AudioVideoError} — `code: 'invalid_argument'` — when
   *   `options.retries` is not a non-negative integer.
   */
  async save(path: string, options: AssetReadOptions = {}): Promise<void> {
    const plan = readPlan(options);
    let file: TempFile | undefined;
    const download = this.#download({
      ...plan,
      restart: async () => {
        await file?.replace();
      },
    });
    // The first request settles before anything touches the disk, so one that
    // fails creates no directory and no temp file.
    const first = await download.next();
    try {
      await mkdir(dirname(path), { recursive: true });
      file = await TempFile.create(path);
      if (first.done !== true) await file.write(first.value);
      for await (const chunk of download) {
        await file.write(chunk);
      }
      await file.commit();
    } catch (err) {
      // Releases the connection when the failure came from the disk side.
      await download.return(undefined);
      await file?.discard();
      throw err instanceof AudioVideoError ? err : this.#wrapTransportError(err, plan.signal);
    }
  }

  /** The redacted, JSON-safe shape `JSON.stringify(asset)` produces. */
  toJSON(): AssetJSON {
    return { url: redactUrl(this.#url), meta: this.meta };
  }

  /** The same redacted shape as {@link Asset.toJSON}, serialized. */
  toString(): string {
    return JSON.stringify(this.toJSON());
  }

  /**
   * Backs `util.inspect(asset)` / `console.log(asset)` —
   * `Symbol.for('nodejs.util.inspect.custom')` is the same well-known symbol
   * Node exposes as `util.inspect.custom`. Returns the same redacted shape as
   * {@link Asset.toJSON} rather than letting the default object inspection run,
   * which would print `.url` — and any SAS/SigV4 signature it carries — in full.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): AssetJSON {
    return this.toJSON();
  }

  /**
   * The one body reader {@link Asset.buffer}, {@link Asset.stream} and
   * {@link Asset.save} share: an async generator over the asset's bytes. Its
   * body does not run until the returned iterator's first pull, which is what
   * makes {@link Asset.stream} lazy. Every failure it throws is already an
   * {@link AudioVideoError}, which `Readable.from` turns into an `'error'`
   * event on the stream {@link Asset.stream} returns, never an unhandled
   * rejection.
   *
   * A response body ends one of three ways: complete, which ends the
   * generator; aborted by `plan.signal`, which rejects `cancelled`; or cut
   * off — a transport error, or a clean end short of the length the response
   * reported — which hands over to `#recover` for the response to read on
   * from.
   */
  async *#download(plan: DownloadPlan): AsyncGenerator<Buffer> {
    const { signal } = plan;
    let attempt = await this.#open(signal);
    const state = downloadState(attempt.res);
    for (;;) {
      let interruption: { cause: unknown } | undefined;
      try {
        for await (const chunk of readBody(attempt.res, signal)) {
          state.offset += chunk.length;
          yield chunk;
        }
      } catch (cause) {
        if (signal?.aborted) throw this.#wrapTransportError(cause, signal);
        interruption = { cause };
      } finally {
        attempt.release();
      }
      if (interruption === undefined) {
        if (state.total === undefined || state.offset >= state.total) return;
        interruption = {
          cause: new Error(
            `The response body ended after ${state.offset} of its ${state.total} bytes.`,
          ),
        };
      }
      attempt = await this.#recover(state, plan, interruption.cause);
    }
  }

  /**
   * Issues a download's first request, resolving once its status is confirmed
   * successful. A `signal` already aborted when called is rejected without
   * ever calling {@link AssetOptions.fetch}. Any rejection from the fetch
   * itself — a malformed or host-relative URL, a DNS failure, a network
   * error — is wrapped the same way a non-2xx response is (as `cancelled`
   * instead, when `signal` is why it rejected). A non-2xx response has its
   * body cancelled before the throw, so the connection is released rather
   * than left open until it is garbage-collected. None of these is retried:
   * resuming continues a body that has already started.
   */
  async #open(signal: AbortSignal | undefined): Promise<Attempt> {
    if (signal?.aborted) throw this.#wrapTransportError(signal.reason, signal);
    let attempt: Attempt;
    try {
      attempt = await this.#request(signal);
    } catch (cause) {
      throw this.#wrapTransportError(cause, signal);
    }
    if (!attempt.res.ok) {
      await discard(attempt);
      throw this.#statusFailure(attempt.res.status, false);
    }
    return attempt;
  }

  /**
   * Re-requests the asset after its body was cut off, and returns the attempt
   * to read on from: a `206` continuing at `state.offset` (see
   * {@link resumptionVerdict}), or — when the server cannot resume and the
   * read may start over (`plan.restart` is set, or nothing has been delivered
   * yet) — a complete response from byte zero, with `state` reset to match.
   * Every re-request spends one of `plan.retries` and waits its backoff
   * first. A server that cannot resume fails a read that may not start over at
   * once, as does a status other than `408`, `429` or a `5xx`.
   */
  async #recover(
    state: DownloadState,
    plan: DownloadPlan,
    interruption: unknown,
  ): Promise<Attempt> {
    const { signal, retries } = plan;
    const mayRestart = plan.restart !== undefined || state.offset === 0;
    let resume = state.resumable && state.offset > 0;
    let last: Failure = { cause: interruption };
    for (;;) {
      if (state.retriesUsed >= retries) throw this.#retriesExhausted(retries, last, signal);
      if (!resume && !mayRestart) {
        throw this.#cannotResume(state.offset, CONTENT_ENCODED, interruption);
      }
      state.retriesUsed += 1;
      try {
        await delay(retryBackoffMs(state.retriesUsed), signal);
      } catch (cause) {
        throw this.#wrapTransportError(cause, signal);
      }
      let attempt: Attempt;
      try {
        attempt = await this.#request(signal, resume ? resumeHeaders(state) : undefined);
      } catch (cause) {
        if (signal?.aborted) throw this.#wrapTransportError(cause, signal);
        last = { cause };
        continue;
      }
      const { res } = attempt;
      const verdict = resume ? resumptionVerdict(res, state) : restartVerdict(res);
      if (verdict.kind === 'continue') {
        state.total ??= verdict.total;
        return attempt;
      }
      if (verdict.kind === 'restart' && mayRestart) {
        if (state.offset > 0) {
          try {
            await plan.restart?.();
          } catch (err) {
            await discard(attempt);
            throw err;
          }
        }
        beginRepresentation(state, res);
        return attempt;
      }
      await discard(attempt);
      if (verdict.kind === 'fatal') throw this.#statusFailure(res.status, true);
      if (verdict.kind === 'retry') {
        last = { status: res.status };
        continue;
      }
      // The server cannot continue at the offset: start over, or fail a read
      // that cannot take back the bytes it has already delivered.
      if (!mayRestart) {
        throw this.#cannotResume(state.offset, verdict.reason, interruption, res.status);
      }
      resume = false;
      last = { cause: interruption, status: res.status >= 400 ? res.status : undefined };
    }
  }

  /**
   * One fetch of the asset. The fetch gets a signal of its own that aborts
   * when `signal` does, unhooked through the returned attempt's `release`:
   * the platform fetch keeps a listener on whatever signal it is handed until
   * that signal is garbage-collected, so handing it the caller's own would
   * leave one behind on the caller's signal for every request a download
   * makes. Rejects exactly as the fetch does.
   */
  async #request(
    signal: AbortSignal | undefined,
    headers?: Record<string, string>,
  ): Promise<Attempt> {
    const link = linkSignals(signal === undefined ? [] : [signal]);
    try {
      const init =
        headers === undefined ? { signal: link.signal } : { signal: link.signal, headers };
      return { res: await this.#fetch(this.#url, init), release: link.release };
    } catch (err) {
      link.release();
      throw err;
    }
  }

  /**
   * The error for a status that fails the download: the first request's
   * non-2xx, or a re-request's status that is neither resumable nor worth
   * retrying.
   */
  #statusFailure(status: number, afterInterruption: boolean): AudioVideoError {
    const when = afterInterruption ? ' after the download was interrupted' : '';
    return new AudioVideoError({
      message: `Fetching the asset at ${redactUrl(this.#url)} failed with status ${status}${when}.`,
      code: 'asset_fetch_failed',
      status,
    });
  }

  /**
   * The error once a download has spent every retry. With `retries: 0` that
   * is the interruption itself, reported as any failed read is; otherwise the
   * message counts the retries spent, and the last failure's status or
   * sanitized cause comes with it.
   */
  #retriesExhausted(
    retries: number,
    last: Failure,
    signal: AbortSignal | undefined,
  ): AudioVideoError {
    if (retries === 0) return this.#wrapTransportError(last.cause, signal);
    return new AudioVideoError({
      message:
        `Fetching the asset at ${redactUrl(this.#url)} failed: the download was interrupted, ` +
        `and ${retries} ${retries === 1 ? 'retry' : 'retries'} did not complete it.`,
      code: 'asset_fetch_failed',
      status: last.status,
      cause: last.cause === undefined ? undefined : sanitizeTransportError(last.cause, this.#url),
    });
  }

  /**
   * The error for a download the server could not resume after `offset`
   * bytes had been delivered, on a read that cannot take those bytes back.
   * Carries `status` when the refusal was an HTTP error (a `416`), and the
   * sanitized interruption as its cause.
   */
  #cannotResume(
    offset: number,
    reason: string,
    interruption: unknown,
    status?: number,
  ): AudioVideoError {
    return new AudioVideoError({
      message:
        `Fetching the asset at ${redactUrl(this.#url)} failed: the download was interrupted after ` +
        `${offset} bytes and could not be resumed, because ${reason}.`,
      code: 'asset_fetch_failed',
      status: status !== undefined && status >= 400 ? status : undefined,
      cause: sanitizeTransportError(interruption, this.#url),
    });
  }

  /**
   * Wraps a rejected fetch or a failed body read as the `AudioVideoError`
   * every accessor promises: `cancelled` — cause: a sanitized
   * `signal.reason` — when `signal` is why the rejection happened, else
   * `asset_fetch_failed` with a redacted URL. Either way the `cause` is —
   * rather than the raw error — sanitized (see
   * {@link sanitizeTransportError}) so it cannot reintroduce the URL through
   * `err.cause` on any printable surface.
   */
  #wrapTransportError(cause: unknown, signal?: AbortSignal): AudioVideoError {
    if (signal?.aborted) {
      return new AudioVideoError({
        message: `Fetching the asset at ${redactUrl(this.#url)} was cancelled.`,
        code: 'cancelled',
        cause: sanitizeTransportError(signal.reason, this.#url),
      });
    }
    return new AudioVideoError({
      message: `Fetching the asset at ${redactUrl(this.#url)} failed.`,
      code: 'asset_fetch_failed',
      cause: sanitizeTransportError(cause, this.#url),
    });
  }
}

/** How one download runs. */
interface DownloadPlan {
  /** The caller's signal. It governs every request, body read and backoff. */
  signal: AbortSignal | undefined;
  /** See {@link AssetReadOptions.retries}; already validated. */
  retries: number;
  /**
   * Set by {@link Asset.save} only: called when a download that has already
   * delivered bytes starts over from byte zero, before the first new byte is
   * yielded. A read without it cannot take delivered bytes back, so a server
   * that cannot resume fails it instead.
   */
  restart?: () => Promise<void>;
}

/** One request of a download: its response, and `release`, which unhooks the request's own signal from the caller's. */
interface Attempt {
  res: Response;
  release: () => void;
}

/** The validator `If-Range` sends, and the response header it came from. */
interface Validator {
  header: 'etag' | 'last-modified';
  value: string;
}

/** What a download knows about the representation it is part-way through. */
interface DownloadState {
  /** Bytes of it delivered so far: the offset a resumption asks for. */
  offset: number;
  /** Its complete length, once a response has reported one. */
  total: number | undefined;
  /** Makes a resumption conditional on the asset being unchanged. */
  validator: Validator | undefined;
  /**
   * `false` for a content-encoded response: its bytes arrive decoded, so
   * their count is no offset into the encoded bytes a `Range` addresses.
   */
  resumable: boolean;
  /** Re-requests made so far, against {@link DownloadPlan.retries}. */
  retriesUsed: number;
}

/** What the last failed attempt left behind, for the error reported once retries run out. */
interface Failure {
  cause?: unknown;
  status?: number;
}

/**
 * What the response to a re-request lets a download do next: `continue` —
 * append its body, a `206` picking up at the offset; `restart` — start over
 * with it, a complete response from byte zero; `refused` — start over with a
 * fresh request, since it cannot continue at the offset (a `416`, a
 * misaligned or changed `206`); `retry` — try again after a `408`, `429` or
 * `5xx`; `fatal` — fail the download on any other status.
 */
type Verdict =
  | { kind: 'continue'; total: number | undefined }
  | { kind: 'restart'; reason: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'retry' }
  | { kind: 'fatal' };

/** The read options every accessor takes, validated, with the default retry budget filled in. */
function readPlan(options: AssetReadOptions): DownloadPlan {
  const { signal, retries = DEFAULT_RETRIES } = options;
  if (!Number.isSafeInteger(retries) || retries < 0) {
    const given = typeof retries === 'number' ? String(retries) : `a ${typeof retries}`;
    throw new AudioVideoError({
      message: `retries must be a non-negative integer; got ${given}.`,
      code: 'invalid_argument',
    });
  }
  return { signal, retries };
}

/** A fresh {@link DownloadState} for the representation `res` carries. */
function downloadState(res: Response): DownloadState {
  const state: DownloadState = {
    offset: 0,
    total: undefined,
    validator: undefined,
    resumable: true,
    retriesUsed: 0,
  };
  beginRepresentation(state, res);
  return state;
}

/** Points `state` at byte zero of the representation `res` carries, keeping its retry count. */
function beginRepresentation(state: DownloadState, res: Response): void {
  state.offset = 0;
  state.resumable = identityEncoded(res.headers);
  state.total = state.resumable ? contentLength(res.headers) : undefined;
  state.validator = validatorOf(res.headers);
}

/** The headers asking for the representation from `state.offset` on, provided it is unchanged. */
function resumeHeaders(state: DownloadState): Record<string, string> {
  const headers: Record<string, string> = { Range: `bytes=${state.offset}-` };
  if (state.validator !== undefined) headers['If-Range'] = state.validator.value;
  return headers;
}

/**
 * The validator `If-Range` sends: the `ETag`, else the `Last-Modified` date.
 * A weak `ETag` (`W/"…"`) never qualifies — `If-Range` compares strongly, so
 * RFC 9110 forbids sending one — and the date stands in for it.
 */
function validatorOf(headers: Headers): Validator | undefined {
  const etag = headers.get('etag');
  if (etag !== null && etag !== '' && !etag.startsWith('W/')) {
    return { header: 'etag', value: etag };
  }
  const lastModified = headers.get('last-modified');
  return lastModified === null || lastModified === ''
    ? undefined
    : { header: 'last-modified', value: lastModified };
}

/** Whether a response's bytes arrive as sent: no `Content-Encoding` other than `identity`. */
function identityEncoded(headers: Headers): boolean {
  const encoding = headers.get('content-encoding')?.trim().toLowerCase();
  return encoding === undefined || encoding === '' || encoding === 'identity';
}

/** `Content-Length` as a byte count, or `undefined` when it is absent or not a plain integer. */
function contentLength(headers: Headers): number | undefined {
  const value = headers.get('content-length')?.trim();
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}

/** `Content-Range: bytes <start>-<end>/<total or *>`, parsed; `undefined` for anything else. */
function parseContentRange(
  value: string | null,
): { start: number; total: number | undefined } | undefined {
  const match = value === null ? null : /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (match === null) return undefined;
  const [, startText = '', endText = '', totalText = ''] = match;
  const start = Number(startText);
  const end = Number(endText);
  const total = totalText === '*' ? undefined : Number(totalText);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return undefined;
  if (total !== undefined && (!Number.isSafeInteger(total) || end >= total)) return undefined;
  return { start, total };
}

/** Whether a status is worth another attempt: a request timeout, throttling, or a server error. */
function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * What the response to a resumption (a `Range` from `state.offset`) lets the
 * download do. A `206` continues it only when its `Content-Range` starts at
 * the offset, reports the same total length (when both are known), and its
 * validator, when it sends one, still matches — `If-Range` alone cannot be
 * relied on, since a server that ignores it serves the range regardless.
 */
function resumptionVerdict(res: Response, state: DownloadState): Verdict {
  const { status, headers } = res;
  if (status === 206) {
    const range = parseContentRange(headers.get('content-range'));
    if (range === undefined || range.start !== state.offset) {
      return {
        kind: 'refused',
        reason: `the server's Content-Range does not continue at byte ${state.offset}`,
      };
    }
    if (range.total !== undefined && state.total !== undefined && range.total !== state.total) {
      return {
        kind: 'refused',
        reason: `the server's Content-Range gives a length of ${range.total} bytes, not ${state.total}`,
      };
    }
    const { validator } = state;
    const current = validator === undefined ? null : headers.get(validator.header);
    if (validator !== undefined && current !== null && current !== validator.value) {
      const name = validator.header === 'etag' ? 'ETag' : 'Last-Modified';
      return { kind: 'refused', reason: `the asset changed: its ${name} no longer matches` };
    }
    return { kind: 'continue', total: range.total };
  }
  if (status === 200) {
    return {
      kind: 'restart',
      reason: 'the server answered 200 with the whole asset (it changed, or ignores byte ranges)',
    };
  }
  if (status === 416) {
    return { kind: 'refused', reason: 'the server answered 416 Range Not Satisfiable' };
  }
  if (res.ok) return { kind: 'refused', reason: `the server answered ${status}, not 206` };
  return retryableStatus(status) ? { kind: 'retry' } : { kind: 'fatal' };
}

/** What the response to a fresh request from byte zero lets the download do. */
function restartVerdict(res: Response): Verdict {
  if (res.ok) return { kind: 'restart', reason: '' };
  return retryableStatus(res.status) ? { kind: 'retry' } : { kind: 'fatal' };
}

/**
 * Full-jitter exponential backoff before the `retry`-th re-request (counting
 * from 1): a uniform random fraction of {@link RETRY_BACKOFF_BASE_MS},
 * doubled for each earlier retry and capped at {@link RETRY_BACKOFF_CAP_MS}
 * before the fraction is taken, so no wait reaches the cap and downloads cut
 * off together do not reconnect in lockstep.
 */
function retryBackoffMs(retry: number): number {
  return Math.random() * Math.min(RETRY_BACKOFF_CAP_MS, RETRY_BACKOFF_BASE_MS * 2 ** (retry - 1));
}

/** Cancels a response body the download will not read, releasing its connection, then unhooks its signal. */
async function discard(attempt: Attempt): Promise<void> {
  await attempt.res.body?.cancel().catch(() => undefined);
  attempt.release();
}

/**
 * The chunks of `res`'s body. The body is destroyed the moment `signal`
 * fires — at once when it already has — releasing the connection rather than
 * leaving it open until the caller notices; a consumer that stops early
 * destroys it too, through the iterator's `return()`.
 */
async function* readBody(res: Response, signal: AbortSignal | undefined): AsyncGenerator<Buffer> {
  if (res.body === null) return;
  const body = Readable.fromWeb(res.body);
  const cleanup = destroyOnAbort(body, signal);
  try {
    yield* body;
  } finally {
    cleanup();
  }
}

/**
 * Destroys `body` the moment `signal` fires, so an abort mid-read releases
 * the connection rather than leaving it open until the caller notices — and
 * at once when `signal` has already fired, which a fetch that ignores its
 * signal can resolve after. Returns a cleanup function the caller must invoke
 * once the read settles (normally, in error, or on the abort itself), so the
 * listener never outlives the read it was registered for.
 */
function destroyOnAbort(body: Readable, signal: AbortSignal | undefined): () => void {
  if (signal === undefined) return () => undefined;
  const onAbort = (): void => {
    body.destroy(signal.reason as Error);
  };
  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/**
 * The temporary file {@link Asset.save} writes into beside its destination,
 * moved onto the destination with one rename once the download completes.
 * {@link TempFile.replace} starts over in a fresh file, so bytes from a
 * representation the download abandoned never reach the destination.
 */
class TempFile {
  readonly #destination: string;
  #path: string;
  #handle: FileHandle;

  private constructor(destination: string, path: string, handle: FileHandle) {
    this.#destination = destination;
    this.#path = path;
    this.#handle = handle;
  }

  /** A new, empty temp file beside `destination`. */
  static async create(destination: string): Promise<TempFile> {
    const path = tempSavePath(destination);
    return new TempFile(destination, path, await open(path, 'w'));
  }

  /** Appends all of `chunk`, however many writes the file system takes to accept it. */
  async write(chunk: Buffer): Promise<void> {
    for (let written = 0; written < chunk.length;) {
      const { bytesWritten } = await this.#handle.write(chunk, written, chunk.length - written);
      written += bytesWritten;
    }
  }

  /** Deletes this file and carries on in a fresh, empty one. */
  async replace(): Promise<void> {
    await this.#handle.close();
    await rm(this.#path, { force: true });
    const path = tempSavePath(this.#destination);
    this.#handle = await open(path, 'w');
    this.#path = path;
  }

  /** Closes the file and renames it onto the destination. */
  async commit(): Promise<void> {
    await this.#handle.close();
    await rename(this.#path, this.#destination);
  }

  /** Closes and deletes the file. Never throws: it runs on a path that is already failing. */
  async discard(): Promise<void> {
    await this.#handle.close().catch(() => undefined);
    await rm(this.#path, { force: true }).catch(() => undefined);
  }
}

/**
 * A same-directory path {@link Asset.save} streams into before the atomic
 * rename onto `path`, chosen fresh per call so concurrent saves to the same
 * destination never collide and the temp file always shares `path`'s volume.
 */
function tempSavePath(path: string): string {
  return `${path}.${randomUUID()}.partial`;
}

/**
 * Builds a safe substitute for a transport error before it becomes an
 * {@link AudioVideoError}'s `cause`: a plain `Error` carrying the original's
 * `name` (and `code`, when the platform set one) with every occurrence of
 * `rawUrl` — and, as a second pass, any other embedded URL a wrapping
 * message might carry — replaced by its {@link redactUrl}-redacted form.
 * `err` itself, and any `cause` chain hanging off it, is never attached:
 * either could still be holding the unredacted URL.
 */
function sanitizeTransportError(err: unknown, rawUrl: string): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  const withRawUrlRedacted =
    rawUrl.length > 0 && original.message.includes(rawUrl)
      ? original.message.split(rawUrl).join(redactUrl(rawUrl))
      : original.message;
  const sanitized = new Error(redactValue(withRawUrlRedacted));
  sanitized.name = original.name;
  const code = (original as Error & { code?: unknown }).code;
  if (typeof code === 'string') (sanitized as Error & { code?: string }).code = code;
  return sanitized;
}

/**
 * How `render()` hands back a finished output in place of its {@link Asset}
 * (its `resolveAs` option): `'url'` the presigned read URL, `'buffer'` the
 * bytes in memory, `'stream'` a pipeable byte stream, `'file'` the path the
 * output was saved to on disk.
 */
export type ResolveAs = 'url' | 'buffer' | 'stream' | 'file';

/** @internal Options for {@link resolveAsset}. */
export interface ResolveAssetOptions {
  /** See {@link ResolveAs}; `undefined` returns the {@link Asset} itself. */
  resolveAs?: ResolveAs;
  /** Where to save the asset when `resolveAs` is `'file'`; required in that case. */
  savePath?: string;
  /**
   * Forwarded to whichever of {@link Asset.buffer}, {@link Asset.stream}, or
   * {@link Asset.save} `resolveAs` selects.
   */
  signal?: AbortSignal;
}

/**
 * Applies a `resolveAs` shorthand to a finished {@link Asset} — the mechanism
 * behind a capability method's own `resolveAs` option (e.g.
 * `render(spec, { resolveAs: 'file', savePath, signal })`). Each mode has its
 * own overload, so the result is typed precisely: no `resolveAs` gives the
 * `Asset`, `'url'` its URL string, `'buffer'` a `Buffer`, `'stream'` a
 * `Readable`, and `'file'` the path it was saved to.
 *
 * @param asset - The asset to resolve.
 * @param options - See {@link ResolveAssetOptions}.
 * @returns The asset, its URL, its bytes, a stream over it, or the path it was
 *   saved to, depending on `options.resolveAs`.
 * @throws {@link AudioVideoError} — `code: 'invalid_argument'` — when
 *   `resolveAs` is `'file'` and `savePath` is missing, or when `resolveAs` is
 *   any value other than `undefined` and the four recognized modes (reachable
 *   only from a non-TypeScript caller, e.g. a CLI flag).
 *
 * @example
 * ```ts
 * const path = await resolveAsset(asset, { resolveAs: 'file', savePath: './out.mov' }); // -> './out.mov'
 * ```
 *
 * @internal
 */
export function resolveAsset(
  asset: Asset,
  options?: ResolveAssetOptions & { resolveAs?: undefined },
): Promise<Asset>;
/** @internal Resolves with the asset's presigned read URL; nothing is downloaded. */
export function resolveAsset(
  asset: Asset,
  options: ResolveAssetOptions & { resolveAs: 'url' },
): Promise<string>;
/** @internal Reads the whole asset into memory. */
export function resolveAsset(
  asset: Asset,
  options: ResolveAssetOptions & { resolveAs: 'buffer' },
): Promise<Buffer>;
/** @internal Resolves with a lazy byte stream over the asset. */
export function resolveAsset(
  asset: Asset,
  options: ResolveAssetOptions & { resolveAs: 'stream' },
): Promise<Readable>;
/** @internal Saves the asset to `options.savePath` and resolves with that path. */
export function resolveAsset(
  asset: Asset,
  options: ResolveAssetOptions & { resolveAs: 'file' },
): Promise<string>;
/** @internal With a `resolveAs` known only at run time, resolves with whichever form it names. */
export function resolveAsset(
  asset: Asset,
  options?: ResolveAssetOptions,
): Promise<Asset | string | Buffer | Readable>;
export async function resolveAsset(
  asset: Asset,
  options: ResolveAssetOptions = {},
): Promise<Asset | string | Buffer | Readable> {
  const { resolveAs, savePath, signal } = options;
  switch (resolveAs) {
    case undefined:
      return asset;
    case 'url':
      return asset.url;
    case 'buffer':
      return asset.buffer({ signal });
    case 'stream':
      return asset.stream({ signal });
    case 'file':
      if (savePath === undefined) {
        throw new AudioVideoError({
          message: "resolveAsset: 'file' requires a savePath.",
          code: 'invalid_argument',
        });
      }
      await asset.save(savePath, { signal });
      return savePath;
    default:
      throw new AudioVideoError({
        message: `resolveAsset: unrecognized resolveAs "${String(resolveAs)}".`,
        code: 'invalid_argument',
      });
  }
}
