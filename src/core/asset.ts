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
import { redactUrl } from './redact.js';

/**
 * The subset of the global `fetch` function {@link Asset} needs: called with
 * just a URL, resolving with a `Response`. Narrower than `typeof fetch` so a
 * test can inject a single-argument stub directly.
 */
type FetchLike = (url: string) => Promise<Response>;

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
   * @returns The asset's bytes.
   * @throws {@link AudioVideoError} — `code: 'asset_fetch_failed'` — for a
   *   non-2xx response, with a redacted URL in the message.
   */
  async buffer(): Promise<Buffer> {
    const res = await this.#fetchOk();
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * A Node `Readable` over the asset's bytes, for piping anywhere (a write
   * stream, a transform, another request body) without holding the whole file
   * in memory. Lazy: the underlying fetch does not start until the stream is
   * first read — via `.pipe()`, a `'data'` listener, `.resume()`, or an
   * explicit `.read()` — so a `stream()` call that is never consumed issues no
   * request at all. A fetch failure, including a non-2xx response, surfaces as
   * an `'error'` event on the returned stream, never as an unhandled rejection.
   *
   * @returns A readable stream of the asset's bytes.
   */
  stream(): Readable {
    return Readable.from(this.#streamChunks());
  }

  /**
   * Streams the asset directly to `path`, creating any missing parent
   * directories first. Never buffers the whole file in memory — bytes reach
   * disk as they arrive over the network, not after the response completes. A
   * fetch failure, including a non-2xx response, rejects with the same
   * {@link AudioVideoError} {@link buffer} would throw. The download lands in
   * a temporary file beside `path` first and is moved into place with a
   * single rename once it completes; on any failure — the response status,
   * a transport error, or a write/rename error — the temp file is removed
   * and `path` is left exactly as it was beforehand: absent stays absent, an
   * existing file stays byte-identical.
   *
   * @param path - The destination file path.
   */
  async save(path: string): Promise<void> {
    const res = await this.#fetchOk();
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = tempSavePath(path);
    const body = res.body === null ? Readable.from([]) : Readable.fromWeb(res.body);
    try {
      await pipeline(body, createWriteStream(tmpPath));
      await rename(tmpPath, path);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
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
   * once its status is confirmed successful.
   */
  async #fetchOk(): Promise<Response> {
    const res = await this.#fetch(this.#url);
    if (!res.ok) {
      throw new AudioVideoError({
        message: `Fetching the asset at ${redactUrl(this.#url)} failed with status ${res.status}.`,
        code: 'asset_fetch_failed',
        status: res.status,
      });
    }
    return res;
  }

  /**
   * The async generator {@link stream} wraps in `Readable.from`. Its body does
   * not run until the returned stream's first pull, which is what makes
   * {@link stream} lazy: fetching and status-checking happen here, on first
   * read, rather than when `stream()` is called. A rejection thrown from here
   * — the fetch itself failing, or the non-2xx check below — is turned by
   * `Readable.from` into an `'error'` event on the stream it returned, never
   * an unhandled rejection.
   */
  async *#streamChunks(): AsyncGenerator<Buffer> {
    const res = await this.#fetchOk();
    const body = res.body;
    if (body === null) return;
    yield* Readable.fromWeb(body);
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
 * The way {@link resolveAsset} should hand back a render's finished output:
 * the {@link Asset} handle itself (`undefined`), its presigned URL, an
 * in-memory buffer, a pipeable stream, or the path it was saved to on disk.
 */
export type ResolveAs = 'url' | 'buffer' | 'stream' | 'file';

/**
 * Applies a `resolveAs` shorthand to a finished {@link Asset} — the mechanism
 * behind a capability method's own `resolveAs` option (e.g.
 * `av.render(spec, { resolveAs: 'file', savePath })`).
 *
 * @param asset - The asset to resolve.
 * @param resolveAs - `undefined` returns `asset` itself; `'url'` returns
 *   `asset.url`; `'buffer'` awaits {@link Asset.buffer}; `'stream'` returns
 *   {@link Asset.stream}; `'file'` awaits {@link Asset.save} and returns
 *   `savePath`.
 * @param savePath - Where to save the asset when `resolveAs` is `'file'`;
 *   required in that case.
 * @returns The asset, its URL, its bytes, a stream over it, or the path it was
 *   saved to, depending on `resolveAs`.
 * @throws {@link AudioVideoError} — `code: 'invalid_argument'` — when
 *   `resolveAs` is `'file'` and `savePath` is missing, or when `resolveAs` is
 *   any value other than `undefined` and the four recognized modes (reachable
 *   only from a non-TypeScript caller, e.g. a CLI flag).
 *
 * @example
 * ```ts
 * const path = await resolveAsset(asset, 'file', './out.mov'); // -> './out.mov'
 * ```
 */
export async function resolveAsset(
  asset: Asset,
  resolveAs?: ResolveAs,
  savePath?: string,
): Promise<Asset | string | Buffer | Readable> {
  switch (resolveAs) {
    case undefined:
      return asset;
    case 'url':
      return asset.url;
    case 'buffer':
      return asset.buffer();
    case 'stream':
      return asset.stream();
    case 'file':
      if (savePath === undefined) {
        throw new AudioVideoError({
          message: "resolveAsset: 'file' requires a savePath.",
          code: 'invalid_argument',
        });
      }
      await asset.save(savePath);
      return savePath;
    default:
      throw new AudioVideoError({
        message: `resolveAsset: unrecognized resolveAs "${String(resolveAs)}".`,
        code: 'invalid_argument',
      });
  }
}
