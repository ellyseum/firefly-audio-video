/**
 * The capability-neutral handle every audio-video output resolves to: today a
 * finished DGR render, later any other capability's finished asset. Wraps a
 * presigned read URL with the ways of consuming it — free URL access, an
 * in-memory buffer, a pipeable stream, or a direct-to-disk save — plus the
 * timing derived from the job that produced it.
 */

import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AudioVideoError } from './errors.js';
import type { JobMeta } from './job.js';
import { redactUrl, redactValue } from './redact.js';

/**
 * The subset of the global `fetch` function {@link Asset} needs: called with
 * a URL and an options object carrying the caller's `signal`, resolving with
 * a `Response`. Narrower than `typeof fetch` so a test can inject a stub
 * matching this exact two-argument shape.
 */
type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** Construction options for {@link Asset}. */
export interface AssetOptions {
  /** The presigned read URL naming the asset — see {@link Asset.url}. */
  url: string;
  /** Timing derived from the job that produced the asset — see {@link Asset.meta}. */
  meta: JobMeta;
  /**
   * Replaces the fetch every accessor issues its request through. Defaults to
   * `globalThis.fetch`; a test drives this with an undici `MockAgent`-backed
   * stub, or a hand-built `Response`, instead of mutating the global dispatcher.
   */
  fetch?: FetchLike;
}

/** Options shared by {@link Asset.buffer}, {@link Asset.stream}, and {@link Asset.save}. */
export interface AssetReadOptions {
  /**
   * Aborts the underlying fetch, or an in-progress body read, when it fires.
   * An abort rejects — or, on {@link Asset.stream}, emits — an
   * {@link AudioVideoError} `code: 'cancelled'`, rather than whatever error
   * shape the platform's own abort produces.
   */
  signal?: AbortSignal;
}

/** The redacted, JSON-safe shape {@link Asset.toJSON} produces. */
export interface AssetJSON {
  /** {@link Asset.url}, with any SAS/SigV4 signing parameters removed. */
  url: string;
  meta: JobMeta;
}

/**
 * A finished audio-video output: a presigned read URL plus every way of
 * consuming it. `.url` is free — nothing is fetched until {@link buffer},
 * {@link stream}, or {@link save} is called, and each of those issues its own
 * request rather than sharing one response across calls.
 *
 * `.url` is deliberately unredacted — it is the working handle a caller passes
 * to `fetch`, a download manager, or another service, and redacting it would
 * make it useless for that. Redaction applies everywhere this asset might
 * instead be *logged or displayed*: {@link toJSON}, {@link toString}, and
 * `console.log` (via the `util.inspect` custom hook) all report a scrubbed URL.
 *
 * @example
 * ```ts
 * const asset = await av.render(spec);
 * asset.url;                      // presigned read URL — free, nothing downloaded
 * await asset.buffer();           // in memory (small files)
 * asset.stream();                 // Node Readable, pipe anywhere
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
   * (a multi-gigabyte ProRes master, say) should use {@link stream} or
   * {@link save} instead, neither of which buffers the full body.
   *
   * @param options - See {@link AssetReadOptions}.
   * @returns The asset's bytes.
   * @throws {@link AudioVideoError} — `code: 'asset_fetch_failed'` — for a
   *   non-2xx response or any other fetch failure (a malformed URL, a DNS
   *   failure, a reset mid-download), always with a redacted URL and a
   *   sanitized `cause` in place of the raw error.
   * @throws {@link AudioVideoError} — `code: 'cancelled'` — when
   *   `options.signal` aborts before or during the read.
   */
  async buffer(options: AssetReadOptions = {}): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.#streamChunks(options.signal)) {
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
   * fetch failure — a non-2xx response, a malformed URL, a DNS failure, a
   * reset mid-download, an abort — surfaces as an `'error'` event carrying
   * the same {@link AudioVideoError} {@link buffer} would throw, never as an
   * unhandled rejection.
   *
   * @param options - See {@link AssetReadOptions}.
   * @returns A readable byte stream over the asset's bytes.
   */
  stream(options: AssetReadOptions = {}): Readable {
    return Readable.from(this.#streamChunks(options.signal), { objectMode: false });
  }

  /**
   * Streams the asset directly to `path`, creating any missing parent
   * directories first. Never buffers the whole file in memory — bytes reach
   * disk as they arrive over the network, not after the response completes. A
   * fetch failure — a non-2xx response, a malformed URL, a DNS failure, a
   * reset mid-download, an abort — rejects with the same
   * {@link AudioVideoError} {@link buffer} would throw. The download lands
   * in a temporary file beside `path` first and is moved into place with a
   * single rename once it completes; on any failure — the response status,
   * a transport error, an abort, or a write/rename error — the temp file is
   * removed and `path` is left exactly as it was beforehand: absent stays
   * absent, an existing file stays byte-identical.
   *
   * @param path - The destination file path.
   * @param options - See {@link AssetReadOptions}.
   */
  async save(path: string, options: AssetReadOptions = {}): Promise<void> {
    const { signal } = options;
    const res = await this.#fetchOk(signal);
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = tempSavePath(path);
    const body = res.body === null ? Readable.from([]) : Readable.fromWeb(res.body);
    try {
      await pipeline(body, createWriteStream(tmpPath), { signal });
      await rename(tmpPath, path);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw err instanceof AudioVideoError ? err : this.#wrapTransportError(err, signal);
    }
  }

  /** The redacted, JSON-safe shape `JSON.stringify(asset)` produces. */
  toJSON(): AssetJSON {
    return { url: redactUrl(this.#url), meta: this.meta };
  }

  /** The same redacted shape as {@link toJSON}, serialized. */
  toString(): string {
    return JSON.stringify(this.toJSON());
  }

  /**
   * Backs `util.inspect(asset)` / `console.log(asset)` —
   * `Symbol.for('nodejs.util.inspect.custom')` is the same well-known symbol
   * Node exposes as `util.inspect.custom`. Returns the same redacted shape as
   * {@link toJSON} rather than letting the default object inspection run,
   * which would print `.url` — and any SAS/SigV4 signature it carries — in full.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): AssetJSON {
    return this.toJSON();
  }

  /**
   * Issues the fetch every accessor is built on, resolving with the response
   * once its status is confirmed successful. A `signal` already aborted when
   * called is rejected without ever calling {@link AssetOptions.fetch}. Any
   * rejection from the fetch itself — a malformed or host-relative URL, a
   * DNS failure, a network error — is wrapped the same way a non-2xx
   * response is (as `cancelled` instead, when `signal` is why it rejected).
   * A non-2xx response has its body cancelled before the throw, so the
   * connection is released rather than left open until it is
   * garbage-collected.
   */
  async #fetchOk(signal?: AbortSignal): Promise<Response> {
    if (signal?.aborted) throw this.#wrapTransportError(signal.reason, signal);
    let res: Response;
    try {
      res = await this.#fetch(this.#url, { signal });
    } catch (cause) {
      throw this.#wrapTransportError(cause, signal);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new AudioVideoError({
        message: `Fetching the asset at ${redactUrl(this.#url)} failed with status ${res.status}.`,
        code: 'asset_fetch_failed',
        status: res.status,
      });
    }
    return res;
  }

  /**
   * The async generator {@link stream} wraps in `Readable.from`, and
   * {@link buffer} drains directly. Its body does not run until the
   * returned iterator's first pull, which is what makes {@link stream} lazy:
   * fetching and status-checking happen here, on first read, rather than
   * when `stream()` is called. `signal` destroys the body the moment it
   * fires, releasing the connection instead of waiting for the caller to
   * notice. A rejection thrown from here — the fetch itself failing, the
   * non-2xx check inside {@link #fetchOk}, or a failure (including an abort)
   * reading the body below — is turned by `Readable.from` into an `'error'`
   * event on the stream {@link stream} returns, never an unhandled rejection.
   */
  async *#streamChunks(signal?: AbortSignal): AsyncGenerator<Buffer> {
    const res = await this.#fetchOk(signal);
    const body = res.body === null ? Readable.from([]) : Readable.fromWeb(res.body);
    const cleanup = destroyOnAbort(body, signal);
    try {
      yield* body;
    } catch (cause) {
      throw this.#wrapTransportError(cause, signal);
    } finally {
      cleanup();
    }
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

/**
 * Destroys `body` the moment `signal` fires, so an abort mid-read releases
 * the connection rather than leaving it open until the caller notices.
 * Returns a cleanup function the caller must invoke once the read settles
 * (normally, in error, or on the abort itself), so the listener never
 * outlives the read it was registered for.
 */
function destroyOnAbort(body: Readable, signal: AbortSignal | undefined): () => void {
  if (signal === undefined) return () => undefined;
  const onAbort = (): void => {
    body.destroy(signal.reason as Error);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
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
 * The way {@link resolveAsset} should hand back a render's finished output:
 * the {@link Asset} handle itself (`undefined`), its presigned URL, an
 * in-memory buffer, a pipeable stream, or the path it was saved to on disk.
 */
export type ResolveAs = 'url' | 'buffer' | 'stream' | 'file';

/** Options for {@link resolveAsset}. */
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
 */
export function resolveAsset(
  asset: Asset,
  options?: ResolveAssetOptions & { resolveAs?: undefined },
): Promise<Asset>;
/** Resolves with the asset's presigned read URL; nothing is downloaded. */
export function resolveAsset(
  asset: Asset,
  options: ResolveAssetOptions & { resolveAs: 'url' },
): Promise<string>;
/** Reads the whole asset into memory. */
export function resolveAsset(
  asset: Asset,
  options: ResolveAssetOptions & { resolveAs: 'buffer' },
): Promise<Buffer>;
/** Resolves with a lazy byte stream over the asset. */
export function resolveAsset(
  asset: Asset,
  options: ResolveAssetOptions & { resolveAs: 'stream' },
): Promise<Readable>;
/** Saves the asset to `options.savePath` and resolves with that path. */
export function resolveAsset(
  asset: Asset,
  options: ResolveAssetOptions & { resolveAs: 'file' },
): Promise<string>;
/** With a `resolveAs` known only at run time, resolves with whichever form it names. */
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
