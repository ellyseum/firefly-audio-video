/**
 * {@link AioFilesStorageProvider}: staging through Adobe I/O Files
 * (`@adobe/aio-lib-files`), the blob store every App Builder workspace has.
 */

import * as fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { StageInput, StorageProvider } from '../core/storage.js';
import { exportOf, loadPeer, type Peer } from './peer.js';
import {
  OUTPUT_EXPIRY_SECONDS,
  READ_EXPIRY_SECONDS,
  adapterError,
  checkExpiry,
  invalidOption,
  keyPrefix,
  objectKey,
  readAll,
  uploadBody,
  type UploadBody,
} from './shared.js';

/** The part of an `@adobe/aio-lib-files` `Files` client {@link AioFilesStorageProvider} calls. */
export interface AioFilesClient {
  /**
   * Presigns `filePath` with `options.permissions` (`'r'`, `'w'`, `'rw'`)
   * for `options.expiryInSeconds` seconds; `urlType: 'external'` asks for a
   * URL reachable from outside Runtime.
   */
  generatePresignURL(
    filePath: string,
    options: { expiryInSeconds: number; permissions: string; urlType: string },
  ): Promise<string>;
}

/** The part of the `@adobe/aio-lib-files` module {@link AioFilesStorageProvider} calls. */
export interface AioFilesModule {
  /**
   * Initializes a `Files` client for the Runtime namespace `config.ow` names;
   * `config.tvm.cacheFile` is where the library caches the credentials its
   * token service hands out, or `false` for no cache.
   */
  init(config?: {
    ow?: { namespace: string; auth: string };
    tvm?: { cacheFile?: string | false };
  }): Promise<AioFilesClient>;
}

/** Options for {@link AioFilesStorageProvider}. */
export interface AioFilesStorageProviderOptions {
  /**
   * The Runtime namespace whose Files store to use. Pass it together with
   * `auth`. Defaults to `__OW_NAMESPACE` inside an action, else
   * `AIO_runtime_namespace`.
   */
  namespace?: string;
  /**
   * The Runtime auth key for `namespace`; never logged or thrown. Defaults to
   * `__OW_API_KEY` inside an action, else `AIO_runtime_auth`.
   */
  auth?: string;
  /**
   * Every key this provider writes goes under this prefix; a missing trailing
   * `/` is added. Defaults to `'firefly-audio-video/'`. A key under `public/`
   * lands in the workspace's public container.
   */
  prefix?: string;
  /**
   * Seconds every URL this provider returns stays valid, from 2 to 86400 (24
   * hours). Defaults to 24 hours: a staged input's URL must last until the
   * service reads it, which can follow a long wait in its queue, and an
   * output's URLs must outlive the render and the download after it.
   */
  expiresIn?: number;
  /**
   * An initialized `Files` client — `await filesLib.init()` — used instead of
   * initializing one; `namespace`, `auth` and `cacheFile` are then unused.
   */
  files?: AioFilesClient;
  /**
   * Where the Files library caches the credentials its token service hands
   * out: short-lived SAS URLs for the workspace's containers. By default the
   * library writes them in plain text to `.tvmCache` in the OS temp directory
   * (`os.tmpdir()`), where anything that can read the file can use them until
   * they expire. A path names another file; `false` turns the cache off, so
   * each initialization asks the token service again. Passed to the library
   * as `tvm.cacheFile`.
   */
  cacheFile?: string | false;
  /**
   * The `@adobe/aio-lib-files` module, used instead of importing it at run
   * time. Pass it in bundled code — an App Builder action built with webpack
   * — where a run-time import cannot find the package.
   */
  module?: AioFilesModule;
}

const NAME = 'AioFilesStorageProvider';

const PEER: Peer = {
  specifier: '@adobe/aio-lib-files',
  provider: NAME,
  install: 'npm install @adobe/aio-lib-files',
  option: 'module',
};

/** The longest lifetime `generatePresignURL` accepts, in seconds. */
const MAX_EXPIRY_SECONDS = 86_400;

/** The shortest lifetime `generatePresignURL` accepts, in seconds. */
const MIN_EXPIRY_SECONDS = 2;

/**
 * Stages through Adobe I/O Files — the blob store every App Builder
 * workspace has — using presigned URLs, which work from inside a deployed
 * action and from any machine alike:
 *
 * - `stageRead` presigns an object for reading and writing, `PUT`s the bytes
 *   to that URL with `x-ms-blob-type: BlockBlob` (expecting `201`), then
 *   presigns the same object for reading and returns that URL. The library's
 *   own `write()` works only inside a deployed action, which is why the
 *   upload goes through a presigned URL.
 * - `allocateOutput` presigns one object twice: for writing, which DGR
 *   renders into, and for reading, which the asset is read from.
 *
 * Every key goes under `prefix` plus a unique name. `@adobe/aio-lib-files` is
 * an optional peer dependency, imported the first time this provider stages
 * or allocates, and `init()` runs once, with the Runtime credentials from the
 * options, else `__OW_NAMESPACE` / `__OW_API_KEY` (inside an action), else
 * `AIO_runtime_namespace` / `AIO_runtime_auth` (what `aio app use` writes).
 * The store belongs to that workspace. The library caches the container SAS
 * URLs it is given in plain text under the OS temp directory unless
 * `cacheFile` says otherwise.
 *
 * A client configured with no `storage` uses one of these automatically when
 * the App Builder environment is present — `__OW_NAMESPACE` or
 * `AIO_runtime_namespace` is set. An explicit `storage` always wins;
 * configure a `PassthroughStorageProvider` to keep a client from uploading.
 * The provider chosen automatically imports `@adobe/aio-lib-files` by name at
 * run time, which cannot reach a package webpack has bundled into the action,
 * so a webpack-bundled action configures its storage itself and passes the
 * module: `new AioFilesStorageProvider({ module: files })`, with
 * `import * as files from '@adobe/aio-lib-files'`.
 *
 * A `Readable` is read into memory before its upload, which needs the length
 * first; stage a large file by its path instead.
 *
 * @example
 * ```ts
 * // An App Builder action bundled with webpack passes the module itself:
 * import * as filesLib from '@adobe/aio-lib-files';
 * configure({ clientId, clientSecret, storage: new AioFilesStorageProvider({ module: filesLib }) });
 * ```
 */
export class AioFilesStorageProvider implements StorageProvider {
  readonly #namespace: string | undefined;
  readonly #auth: string | undefined;
  readonly #prefix: string;
  readonly #expiresIn: number | undefined;
  readonly #injected: AioFilesClient | undefined;
  readonly #module: AioFilesModule | undefined;
  readonly #cacheFile: string | false | undefined;
  #files: Promise<AioFilesClient> | undefined;
  /**
   * The Runtime auth key this provider uses — the option's, else the one
   * `init()` was given — scrubbed from every failure the provider reports.
   */
  #resolvedAuth: string | undefined;

  /**
   * @param options - See {@link AioFilesStorageProviderOptions}.
   * @throws {@link AudioVideoError} `invalid_argument` for an invalid option.
   *   Nothing is imported or initialized until the first call.
   */
  constructor(options: AioFilesStorageProviderOptions = {}) {
    if (options === null || typeof options !== 'object') {
      throw invalidOption(`${NAME} expects an options object.`);
    }
    const { namespace, auth, prefix, expiresIn, files, module, cacheFile } = options;
    if ((namespace === undefined) !== (auth === undefined)) {
      throw invalidOption(`${NAME}: pass namespace and auth together, or neither.`);
    }
    for (const [name, value] of [
      ['namespace', namespace],
      ['auth', auth],
    ] as const) {
      if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
        throw invalidOption(`${NAME}: ${name} must be a non-empty string.`);
      }
    }
    if (files !== undefined && typeof files?.generatePresignURL !== 'function') {
      throw invalidOption(`${NAME}: files must be a Files client with generatePresignURL().`);
    }
    if (
      cacheFile !== undefined &&
      cacheFile !== false &&
      (typeof cacheFile !== 'string' || cacheFile.trim() === '')
    ) {
      throw invalidOption(`${NAME}: cacheFile must be a file path, or false for no cache.`);
    }
    this.#namespace = namespace?.trim();
    this.#auth = auth?.trim();
    this.#resolvedAuth = this.#auth;
    this.#prefix = keyPrefix(prefix, NAME);
    this.#expiresIn = expiresIn === undefined ? undefined : this.#checkExpiry(expiresIn);
    this.#injected = files;
    this.#module = module;
    this.#cacheFile = cacheFile;
  }

  /**
   * Uploads `input` to a new object — or the object `opts.key` names under
   * the prefix — and resolves with a presigned URL DGR can read it from.
   * `opts.signal` goes to the upload's `fetch`, which stops when it aborts
   * and rejects with its reason; presigning takes no signal.
   *
   * @throws {@link AudioVideoError} `invalid_argument` for an input that is
   *   not a local file, a `Buffer` or a `Readable`, or an invalid option;
   *   `missing_peer_dependency` when `@adobe/aio-lib-files` cannot be
   *   imported; `storage_failed` when initializing, presigning or the upload
   *   fails.
   */
  async stageRead(
    input: StageInput,
    opts: { key?: string; contentType?: string; expiresIn?: number; signal?: AbortSignal } = {},
  ): Promise<string> {
    const body = await uploadBody(input, NAME, this.#secrets());
    const key = objectKey(this.#prefix, opts.key, 'staged', body);
    const expiresIn = this.#expiry(opts.expiresIn, READ_EXPIRY_SECONDS);
    const contentType = checkContentType(opts.contentType);
    const payload = await payloadOf(body, this.#secrets());
    const files = await this.#client();
    const uploadUrl = await presign(files, key, 'rw', expiresIn, this.#secrets());
    await putBlob(uploadUrl, payload, contentType, opts.signal, this.#secrets());
    return presign(files, key, 'r', expiresIn, this.#secrets());
  }

  /**
   * Presigns one new object — or the object `opts.key` names under the
   * prefix — for writing and for reading.
   *
   * @throws {@link AudioVideoError} `invalid_argument` for an invalid option;
   *   `missing_peer_dependency` when `@adobe/aio-lib-files` cannot be
   *   imported; `storage_failed` when initializing or presigning fails.
   */
  async allocateOutput(
    opts: { key?: string; expiresIn?: number } = {},
  ): Promise<{ writeUrl: string; readUrl: string }> {
    const key = objectKey(this.#prefix, opts.key, 'outputs');
    const expiresIn = this.#expiry(opts.expiresIn, OUTPUT_EXPIRY_SECONDS);
    const files = await this.#client();
    const writeUrl = await presign(files, key, 'w', expiresIn, this.#secrets());
    const readUrl = await presign(files, key, 'r', expiresIn, this.#secrets());
    return { writeUrl, readUrl };
  }

  /** The credentials a failure this provider reports is scrubbed of: the Runtime auth key, once known. */
  #secrets(): readonly string[] {
    return this.#resolvedAuth === undefined ? [] : [this.#resolvedAuth];
  }

  /** The `Files` client: the one given, or one initialized on first use — again after a failed attempt. */
  #client(): Promise<AioFilesClient> {
    if (this.#injected !== undefined) return Promise.resolve(this.#injected);
    this.#files ??= this.#init().catch((error: unknown) => {
      this.#files = undefined;
      throw error;
    });
    return this.#files;
  }

  async #init(): Promise<AioFilesClient> {
    const ow = runtimeCredentials(this.#namespace, this.#auth);
    this.#resolvedAuth = ow.auth;
    const module = this.#module ?? (await loadPeer(PEER));
    const init = exportOf(module, 'init', PEER);
    if (typeof init !== 'function') {
      throw adapterError(`${PEER.specifier} exports an init that is not a function`);
    }
    const tvm = this.#cacheFile === undefined ? {} : { tvm: { cacheFile: this.#cacheFile } };
    let files: unknown;
    try {
      files = await (init as AioFilesModule['init'])({ ow, ...tvm });
    } catch (error) {
      throw adapterError(`Initializing ${PEER.specifier} failed`, error, this.#secrets());
    }
    if (typeof (files as Partial<AioFilesClient> | null)?.generatePresignURL !== 'function') {
      throw adapterError(`${PEER.specifier} init() resolved without a Files client`);
    }
    return files as AioFilesClient;
  }

  #expiry(value: number | undefined, fallback: number): number {
    return value === undefined ? (this.#expiresIn ?? fallback) : this.#checkExpiry(value);
  }

  #checkExpiry(value: unknown): number {
    return checkExpiry(value, `${NAME}: expiresIn`, MAX_EXPIRY_SECONDS, MIN_EXPIRY_SECONDS);
  }
}

/**
 * @internal The storage a client uses when none is configured: an
 * {@link AioFilesStorageProvider} when the App Builder environment is present
 * (`__OW_NAMESPACE` or `AIO_runtime_namespace` set), else none. It is given
 * no `module`, so it imports `@adobe/aio-lib-files` by name at run time; a
 * webpack-bundled action, where that import cannot reach the bundled
 * package, configures a provider with `module` itself instead.
 */
export function appBuilderStorage(
  env: NodeJS.ProcessEnv = process.env,
): StorageProvider | undefined {
  const present = [env.__OW_NAMESPACE, env.AIO_runtime_namespace].some(
    (value) => typeof value === 'string' && value.trim() !== '',
  );
  return present ? new AioFilesStorageProvider() : undefined;
}

/** The Runtime credentials `init()` gets: the options', else the action's, else the CLI's. */
function runtimeCredentials(
  namespace: string | undefined,
  auth: string | undefined,
): { namespace: string; auth: string } {
  if (namespace !== undefined && auth !== undefined) return { namespace, auth };
  const env = process.env;
  const credentials =
    pair(env.__OW_NAMESPACE, env.__OW_API_KEY) ??
    pair(env.AIO_runtime_namespace, env.AIO_runtime_auth);
  if (credentials !== undefined) return credentials;
  throw invalidOption(
    `${NAME} needs Runtime credentials: pass { namespace, auth }, run inside an App Builder ` +
      'action (__OW_NAMESPACE and __OW_API_KEY), or set AIO_runtime_namespace and AIO_runtime_auth.',
  );
}

function pair(
  namespace: string | undefined,
  auth: string | undefined,
): { namespace: string; auth: string } | undefined {
  const ns = namespace?.trim();
  const key = auth?.trim();
  return ns && key ? { namespace: ns, auth: key } : undefined;
}

/** A `contentType` option, when given. */
function checkContentType(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value !== '') return value;
  throw invalidOption(`${NAME}: contentType must be a non-empty string when provided.`);
}

/**
 * The bytes an upload sends: a file as a Blob read from disk where the
 * runtime can (else in memory), a stream read in full. A failure is scrubbed
 * of `secrets`.
 */
async function payloadOf(body: UploadBody, secrets: readonly string[]): Promise<Blob | Buffer> {
  if (body.kind === 'buffer') return body.data;
  if (body.kind === 'stream') return readAll(body.stream, secrets);
  const openAsBlob = (fs as { openAsBlob?: (path: string) => Promise<Blob> }).openAsBlob;
  try {
    return typeof openAsBlob === 'function'
      ? await openAsBlob(body.path)
      : await readFile(body.path);
  } catch (error) {
    throw adapterError('Reading the input file failed', error, secrets);
  }
}

const ACCESS: Record<'r' | 'w' | 'rw', string> = {
  r: 'read',
  w: 'write',
  rw: 'read-write',
};

/** A presigned URL of `key` with `permissions`; a failure is scrubbed of `secrets`. */
async function presign(
  files: AioFilesClient,
  key: string,
  permissions: 'r' | 'w' | 'rw',
  expiresIn: number,
  secrets: readonly string[],
): Promise<string> {
  let url: unknown;
  try {
    url = await files.generatePresignURL(key, {
      expiryInSeconds: expiresIn,
      permissions,
      urlType: 'external',
    });
  } catch (error) {
    throw adapterError(
      `Presigning ${ACCESS[permissions]} access to the object failed`,
      error,
      secrets,
    );
  }
  if (typeof url !== 'string' || url === '') {
    throw adapterError('generatePresignURL() resolved without a URL');
  }
  return url;
}

/**
 * `PUT`s `payload` to a presigned Azure blob URL as a block blob, stopping
 * when `signal` aborts; anything but `201` is a failure, scrubbed of
 * `secrets` when it carries a cause.
 */
async function putBlob(
  url: string,
  payload: Blob | Buffer,
  contentType: string | undefined,
  signal: AbortSignal | undefined,
  secrets: readonly string[],
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: {
        'x-ms-blob-type': 'BlockBlob',
        ...(contentType !== undefined ? { 'content-type': contentType } : {}),
      },
      body: payload,
      redirect: 'manual',
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (error) {
    throw adapterError('Uploading the object failed before a response arrived', error, secrets);
  }
  try {
    await res.body?.cancel();
  } catch {
    // The response is only read for its status; a failed discard changes nothing.
  }
  if (res.status !== 201) {
    const code = res.headers.get('x-ms-error-code');
    throw adapterError(
      `Uploading the object failed with status ${res.status}${code ? ` (${code})` : ''}`,
    );
  }
}
