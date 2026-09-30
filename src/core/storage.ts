/**
 * The storage seam DGR's URL-only contract depends on. DGR reads every input —
 * the template, its assets, a staged `.epr` — from an http(s) URL, and writes
 * every output to a presigned write URL. A {@link StorageProvider} is how the
 * SDK turns local bytes into a URL DGR can read, and how it obtains an output
 * slot DGR can write to and a caller can read back. One implementation per
 * storage platform; the client uses one only when an input actually needs it.
 * {@link normalizeAsset} is the one place an asset input becomes a URL.
 */

import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { AudioVideoError } from './errors.js';

/**
 * Anything a {@link StorageProvider} can stage: a `Buffer`, a `Readable`, a
 * `URL`, or a string (a local file path).
 */
export type StageInput = Buffer | Readable | URL | string;

/**
 * Stages inputs for DGR to read and allocates the locations DGR writes its
 * outputs to. The client calls {@link StorageProvider.stageRead} for every
 * render input given as bytes or a file — a template, an asset, an `.epr`,
 * a generated `.epr` — and for `stage()`, and
 * {@link StorageProvider.allocateOutput} for every output given no
 * `destination`. An http(s) URL never reaches a provider: it is already
 * something DGR can read.
 *
 * A render's storage calls run inside its pool slot, once the job is
 * admitted and just before it is submitted, so a staged URL is fresh when
 * DGR is sent it however long the job queued. Each call's options carry a
 * `signal` that aborts when the render is cancelled, or its caller's signal
 * aborts, before the submit; pass it to the transport so the upload stops.
 * The built-in providers do: `AioFilesStorageProvider` to its upload's
 * `fetch`, `S3StorageProvider` and `AzureBlobStorageProvider` to their SDK's
 * `abortSignal` on the upload; presigning and signing take none. A provider
 * that ignores the signal cannot hold the call hostage: the call stops
 * waiting the moment it aborts, releases its slot to the next queued job and
 * rejects `cancelled`, while the ignored upload runs on unseen.
 *
 * @example
 * ```ts
 * const storage: StorageProvider = {
 *   async stageRead(input, opts) {
 *     const key = opts?.key ?? `staged/${randomUUID()}`;
 *     await upload(key, input, opts?.contentType);
 *     return presign(key, 'read', opts?.expiresIn);
 *   },
 *   async allocateOutput(opts) {
 *     const key = opts?.key ?? `out/${randomUUID()}`;
 *     return { writeUrl: presign(key, 'write'), readUrl: presign(key, 'read') };
 *   },
 * };
 * configure({ clientId, clientSecret, storage });
 * ```
 */
export interface StorageProvider {
  /**
   * Uploads `input` and resolves with a presigned URL DGR can read it from.
   *
   * @param input - The bytes to stage; see {@link StageInput}.
   * @param opts - `key` names the stored object, `contentType` labels it,
   *   `expiresIn` (seconds) bounds how long the returned URL stays valid, and
   *   `signal` aborts the upload.
   * @returns A presigned read URL for the staged object.
   */
  stageRead(
    input: StageInput,
    opts?: { key?: string; contentType?: string; expiresIn?: number; signal?: AbortSignal },
  ): Promise<string>;
  /**
   * Allocates one output location: DGR `PUT`s the rendered file to `writeUrl`,
   * and the finished asset is read back from `readUrl` — two URLs for the same
   * stored object.
   *
   * @param opts - `key` names the stored object, `expiresIn` (seconds) bounds
   *   how long both URLs stay valid, and `signal` aborts any request the
   *   allocation makes.
   * @returns The write URL DGR renders into and the read URL the asset is read from.
   */
  allocateOutput(opts?: {
    key?: string;
    expiresIn?: number;
    signal?: AbortSignal;
  }): Promise<{ writeUrl: string; readUrl: string }>;
}

/**
 * Turns any asset input into a URL DGR can read: an http(s) URL — a string or
 * a `URL` — passes through untouched, with no storage call; a `Buffer`, a
 * `Readable`, or a local file (a path string naming an existing file, or a
 * `file:` URL) is uploaded through `provider.stageRead`, and the presigned
 * read URL it resolves with is returned.
 *
 * A string that is neither an http(s) URL nor the path of an existing file is
 * refused rather than guessed at, so a mistyped path fails here instead of
 * inside a render.
 *
 * @param input - The asset: see {@link StageInput}.
 * @param provider - Stages the inputs that need it; unused for a URL.
 * @param opts - Passed to `provider.stageRead`: the stored object's `key`, its
 *   `contentType`, how many seconds (`expiresIn`) the URL stays valid, and a
 *   `signal` that aborts the upload.
 * @returns A URL DGR can read the asset from.
 * @throws {@link AudioVideoError} `invalid_argument` for a string that is
 *   neither an http(s) URL nor an existing file, a URL of another scheme, any
 *   other kind of value, or an input that needs staging when no `provider` is
 *   given; `storage_failed` when the provider fails or resolves without a URL
 *   (an {@link AudioVideoError} the provider throws passes through as it is).
 *
 * @example
 * ```ts
 * await normalizeAsset('https://example.com/logo.png'); // returned as it is
 * await normalizeAsset('./logo.png', storage); // uploaded; resolves a presigned read URL
 * await normalizeAsset(await readFile('./logo.png'), storage, { contentType: 'image/png' });
 * ```
 */
export async function normalizeAsset(
  input: StageInput,
  provider?: StorageProvider,
  opts?: { key?: string; contentType?: string; expiresIn?: number; signal?: AbortSignal },
): Promise<string> {
  const asset = await classifyAsset(input);
  if (asset.kind === 'url') return asset.url;
  if (provider === undefined) throw noStorage('The input');
  let url: unknown;
  try {
    url = await provider.stageRead(asset.input, stageOptions(opts));
  } catch (cause) {
    throw storageFailure('Staging the input failed.', cause);
  }
  if (typeof url !== 'string' || url === '') {
    throw storageFailure('storage.stageRead() resolved without a URL for the staged object.');
  }
  return url;
}

/**
 * A {@link StorageProvider} for callers who always supply URLs: `stageRead`
 * returns an http(s) URL as it is and refuses anything that would need an
 * upload, and `allocateOutput` always refuses, since this provider has nowhere
 * to put a file. Configure it to keep a client from ever uploading — inside an
 * App Builder environment too, where a client with no `storage` otherwise uses
 * Adobe I/O Files.
 *
 * @example
 * ```ts
 * configure({ clientId, clientSecret, storage: new PassthroughStorageProvider() });
 * ```
 */
export class PassthroughStorageProvider implements StorageProvider {
  /**
   * Resolves with `input` when it is an http(s) URL — a string as it is, a
   * `URL` as its `href`.
   *
   * @throws {@link AudioVideoError} `invalid_argument` for anything else.
   */
  async stageRead(input: StageInput): Promise<string> {
    const url = httpUrlOf(input);
    if (url !== undefined) return url;
    throw invalidInput(
      'PassthroughStorageProvider does not upload: pass an http(s) URL, or configure a storage ' +
        'provider that stages files.',
    );
  }

  /**
   * Always rejects: give each output a `destination` instead.
   *
   * @throws {@link AudioVideoError} `invalid_argument`, always.
   */
  async allocateOutput(): Promise<{ writeUrl: string; readUrl: string }> {
    throw invalidInput(
      'PassthroughStorageProvider cannot allocate an output location: give each output a ' +
        'destination and a readUrl, or configure a storage provider that allocates them.',
    );
  }
}

/**
 * @internal An asset input as {@link classifyAsset} reads it: a URL DGR can
 * read as it is, or something a storage provider stages first — a `Buffer`, a
 * `Readable`, or the path of an existing file.
 */
export type ClassifiedAsset =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'stage'; readonly input: Buffer | Readable | string };

/**
 * @internal Reads what an asset input is without uploading anything: an
 * http(s) URL, or something to stage. A `file:` URL, as a `URL` or a string,
 * becomes the path it names. Only the local filesystem is consulted, to tell
 * an existing file from a mistyped path.
 *
 * @throws {@link AudioVideoError} `invalid_argument` for anything else.
 */
export async function classifyAsset(input: unknown): Promise<ClassifiedAsset> {
  const url = httpUrlOf(input);
  if (url !== undefined) return { kind: 'url', url };
  if (Buffer.isBuffer(input) || isReadable(input)) return { kind: 'stage', input };
  if (input instanceof URL) {
    if (input.protocol !== 'file:') {
      throw invalidInput(
        `The input is a ${input.protocol} URL: DGR reads http(s) URLs, and a file: URL names a local file to upload.`,
      );
    }
    return { kind: 'stage', input: await existingFile(filePathOf(input)) };
  }
  if (typeof input === 'string') {
    if (input === '') throw invalidInput(`The input is an empty string. ${EXPECTED_INPUT}`);
    if (/^file:/i.test(input))
      return { kind: 'stage', input: await existingFile(filePathOf(input)) };
    if (await isFile(input)) return { kind: 'stage', input };
    throw invalidInput(
      `The input ${describeText(input)} is neither an http(s) URL nor an existing file.`,
    );
  }
  throw invalidInput(`The input is ${kindOf(input)}. ${EXPECTED_INPUT}`);
}

/**
 * @internal The `invalid_argument` error for an input that must be staged
 * when no storage is configured, naming the option that fixes it.
 *
 * @param what - The input, as the message names it, e.g. `'source'`.
 */
export function noStorage(what: string): AudioVideoError {
  return invalidInput(
    `${what} must be uploaded for DGR to read it, and no storage is configured: pass a ` +
      'StorageProvider as the storage option of configure() or createClient(), or pass an ' +
      'http(s) URL instead.',
  );
}

/** @internal The http(s) URL `input` is — a string as it is, or a `URL`'s `href` — or `undefined`. */
export function httpUrlOf(input: unknown): string | undefined {
  if (input instanceof URL) {
    return input.protocol === 'http:' || input.protocol === 'https:' ? input.href : undefined;
  }
  if (typeof input !== 'string' || !/^https?:\/\//i.test(input)) return undefined;
  try {
    new URL(input);
    return input;
  } catch {
    return undefined;
  }
}

/**
 * @internal True for a Node `Readable`, or for a stream from another copy of
 * the stream library that pipes and iterates like one.
 */
export function isReadable(value: unknown): value is Readable {
  if (value instanceof Readable) return true;
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { pipe?: unknown; [Symbol.asyncIterator]?: unknown };
  return (
    typeof candidate.pipe === 'function' && typeof candidate[Symbol.asyncIterator] === 'function'
  );
}

/**
 * @internal A storage provider's failure as the SDK reports it: an
 * {@link AudioVideoError} the provider threw passes through; anything else is
 * wrapped with `code: 'storage_failed'`, keeping the original as `cause`.
 */
export function storageFailure(message: string, cause?: unknown): AudioVideoError {
  if (cause instanceof AudioVideoError) return cause;
  return new AudioVideoError({ message, code: 'storage_failed', cause });
}

const EXPECTED_INPUT =
  'Expected an http(s) URL, the path of an existing file, a file: URL, a Buffer or a Readable.';

/** How much of an input string an error message quotes. */
const QUOTE_LIMIT = 120;

/** The options `stageRead` takes. */
type StageReadOptions = NonNullable<Parameters<StorageProvider['stageRead']>[1]>;

/** `stageRead` options with their `undefined` entries left out. */
function stageOptions(opts: StageReadOptions = {}): StageReadOptions {
  const { key, contentType, expiresIn, signal } = opts;
  return {
    ...(key !== undefined ? { key } : {}),
    ...(contentType !== undefined ? { contentType } : {}),
    ...(expiresIn !== undefined ? { expiresIn } : {}),
    ...(signal !== undefined ? { signal } : {}),
  };
}

/** The local path a `file:` URL names. */
function filePathOf(url: URL | string): string {
  try {
    return fileURLToPath(url);
  } catch {
    throw invalidInput('The input is a file: URL that does not name a local file.');
  }
}

/** `path` when it names an existing file. */
async function existingFile(path: string): Promise<string> {
  if (await isFile(path)) return path;
  throw invalidInput('The input is a file: URL that names no existing file.');
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** A string for an error message, quoted and cut short. */
function describeText(text: string): string {
  const quoted = JSON.stringify(text);
  return quoted.length > QUOTE_LIMIT ? `${quoted.slice(0, QUOTE_LIMIT - 4)}..."` : quoted;
}

/** A value's kind for an error message — never the value itself. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

function invalidInput(message: string): AudioVideoError {
  return new AudioVideoError({ message, code: 'invalid_argument' });
}
