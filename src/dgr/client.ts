/**
 * The audio-video client: one credential, one HTTP client, one logger and one
 * concurrency pool behind the method surface `createClient()` returns — the
 * surface the top-level functions reach through the default client.
 * `render()` and `describe()` run every job inside the client's pool, from
 * staging its inputs until the job — its submit and any cancel request
 * included — has settled; `status()`, `cancel()`,
 * `listPresets()` and `stage()` run outside it. Every public call emits
 * exactly one log record when it settles.
 */

import type { Readable } from 'node:stream';
import { resolveAsset, type Asset, type ResolveAs } from '../core/asset.js';
import { resolveTokenProvider, type TokenProvider } from '../core/auth.js';
import { AudioVideoError } from '../core/errors.js';
import { HttpClient, hostOrigin } from '../core/http.js';
import { redactError } from '../core/redact.js';
import {
  runJob,
  type AsyncJob,
  type JobStatusLike,
  type JobSubmission,
  type PollInterval,
} from '../core/job.js';
import {
  buildLogRecord,
  emit,
  resolveLogger,
  type BuildLogRecordInput,
  type Logger,
  type LoggingOption,
} from '../core/logging.js';
import { InMemoryPool, type PoolBackend } from '../core/pool.js';
import { untilAborted } from '../core/signals.js';
import {
  rejectedJob,
  runPooledJob,
  type JobHandle,
  type PooledJobOutcome,
  type StageJob,
} from '../core/pooled-job.js';
import { normalizeAsset, type StageInput, type StorageProvider } from '../core/storage.js';
import { appBuilderStorage } from '../storage/aio-files.js';
import {
  createRenderBuilder,
  type FluentRenderer,
  type RenderBuilder,
  type RenderBuilderOptions,
} from './builder.js';
import {
  describeResult,
  materializeDescribe,
  prepareDescribe,
  type DescribeInput,
  type TemplateDescription,
} from './describe.js';
import { encode, presets, resize, type PresetInput } from './preset.js';
import {
  invalidArgument,
  isTemplateSource,
  materializeRender,
  prepareFluent,
  prepareRequest,
  presetLogFields,
  renderAssets,
  type FluentRenderInput,
  type PreparedRender,
} from './render.js';
import type {
  PresetRefInput,
  RenderRequest,
  RenderRequestOutput,
  TemplateSource,
} from './schemas.js';

/**
 * The handle `render()` and `describe()` return: awaitable like a promise,
 * with the service's `jobId` once the submit resolves, the job's `meta` once
 * it is terminal, and `cancel()` at any point. See {@link JobHandle}.
 *
 * @example
 * ```ts
 * const job = render(spec);
 * const giveUp = setTimeout(() => void job.cancel(), 10 * 60_000);
 * const asset = await job.finally(() => clearTimeout(giveUp));
 * console.log(job.jobId, job.meta?.totalMs);
 * ```
 */
export type RenderJob<T> = JobHandle<T>;

/**
 * A {@link RenderRequest} with exactly one output — the shape that types
 * `render()`'s result as {@link Asset} rather than `Asset | Asset[]`.
 * `presets` and `outputs` both accept a readonly array as well as a mutable
 * one, so a spec built with `as const` still matches.
 *
 * @example
 * ```ts
 * const spec: SingleOutputRenderRequest = {
 *   source: capsuleUrl,
 *   presets: ['h264Land1080pHq'],
 *   outputs: [{ presetIndex: 0, destination: writeUrl, readUrl }],
 * };
 * const asset = await render(spec); // Asset, not Asset | Asset[]
 * ```
 */
export type SingleOutputRenderRequest = Omit<RenderRequest, 'presets' | 'outputs'> & {
  presets: readonly (PresetInput | PresetRefInput)[];
  outputs: readonly [RenderRequestOutput];
};

/**
 * Configuration for {@link createClient} and `configure()`. `clientId` is
 * always required — it is sent as the `x-api-key` header on every request.
 * Authenticate with `clientSecret` (the SDK mints IMS server-to-server tokens
 * through the official provider), or pass a `tokenProvider` that supplies
 * tokens itself.
 *
 * @example
 * ```ts
 * const client = createClient({
 *   clientId: process.env.IMS_OAUTH_S2S_CLIENT_ID!,
 *   clientSecret: process.env.IMS_OAUTH_S2S_CLIENT_SECRET!,
 *   storage,
 *   concurrency: 10,
 *   logging: 'warn',
 * });
 * ```
 */
export interface ClientConfig {
  /** The integration's client ID, sent as `x-api-key` on every request. */
  clientId: string;
  /** The integration's client secret. Required unless `tokenProvider` is given; never logged or thrown. */
  clientSecret?: string;
  /**
   * The IMS scopes to request with `clientSecret`: a comma-separated string, a
   * JSON-array string (the form aio-generated `.env` files store), or an array
   * of scope names — normalized to the single comma-joined string IMS accepts.
   * Defaults to `openid,AdobeID,firefly_api,ff_apis`.
   */
  scope?: string | readonly string[];
  /** Supplies bearer tokens instead of `clientSecret`; `clientId` is still sent as `x-api-key`. */
  tokenProvider?: TokenProvider;
  /** The API host. Defaults to `https://audio-video-api.adobe.io`. */
  host?: string;
  /**
   * Where each call's log record goes: omitted or `true` for NDJSON on stdout,
   * `false` for nothing, a level to drop records below it, or a `Logger` of
   * your own. Every record is redacted before any sink sees it.
   */
  logging?: LoggingOption;
  /**
   * Uploads what DGR must read from a URL, and allocates the locations it
   * writes to: a spec's `source`, `assets` and `{ url }` presets, and the
   * template of a fluent `render(source)` or a `describe()`, given as a file,
   * a `Buffer` or a `Readable`; generated `.epr` presets; `stage()` inputs;
   * and every output with no `destination`, fluent renders included. Without
   * it, any of those rejects `invalid_argument`; http(s) URLs never need it.
   *
   * Staging holds the job's pool slot: a render's or describe's uploads,
   * generated `.epr` files and output allocations run once the job is
   * admitted, just before its submit, so a staged URL is fresh when DGR is
   * sent it however long the job queued. `AioFilesStorageProvider` and `S3StorageProvider` read a
   * `Readable` into memory before uploading it — the store needs its length —
   * so pass a file path to stream a large input from disk. A render or a
   * describe stages while it holds its slot, so at most `concurrency` of them
   * hold such bytes in memory at once; `stage()` takes no slot, and each call
   * holding a `Readable` adds its own.
   *
   * Omitted, a client in an App Builder environment — `__OW_NAMESPACE` or
   * `AIO_runtime_namespace` set — uses an `AioFilesStorageProvider`, and any
   * other client has none. A `storage` given here always wins; pass a
   * `PassthroughStorageProvider` for a client that must never upload. That
   * automatic provider imports `@adobe/aio-lib-files` by name at run time,
   * which cannot reach a package webpack has bundled into the action: a
   * webpack-bundled action passes
   * `new AioFilesStorageProvider({ module: files })` here, with
   * `import * as files from '@adobe/aio-lib-files'`.
   */
  storage?: StorageProvider;
  /**
   * How many jobs this client runs at once; further `render()` and
   * `describe()` calls queue for a slot. An integer `>= 1`; defaults to `10`.
   * Ignored when `pool` is given.
   */
  concurrency?: number;
  /** The pool jobs run in, replacing the built-in in-memory pool — e.g. a distributed one shared by several processes. */
  pool?: PoolBackend;
  /** Retry tuning: `maxRetries` bounds the backoff retries a request gets on `429` (default `5`). */
  retry?: { maxRetries?: number };
}

/** Options for `render(spec, options)`. */
export interface RenderOptions {
  /** Runs this render on `client` rather than the default client (or the client whose `render()` was called). */
  client?: Client;
  /**
   * Resolves with the finished output in this form instead of the `Asset`:
   * `'url'` its read URL, `'buffer'` its bytes, `'stream'` a byte stream,
   * `'file'` the path it was saved to (`savePath`). Valid only for a spec with
   * exactly one output.
   */
  resolveAs?: ResolveAs;
  /** Where `resolveAs: 'file'` saves the output; required with it. */
  savePath?: string;
  /**
   * Cancels the render when it aborts, including the download `resolveAs`
   * performs: before the job is submitted nothing is submitted; after, the
   * service is asked to stop the job. The render rejects `cancelled` with the
   * abort reason as `cause`.
   */
  signal?: AbortSignal;
  /**
   * Called once per status poll with the raw status body, the terminal poll
   * included. If it throws, the render rejects `callback_failed` with the
   * thrown value as `cause`, and a job still running is asked to stop.
   */
  onProgress?: (status: JobStatusLike) => void;
  /**
   * Milliseconds between status polls — a constant, or a function of the
   * milliseconds elapsed since the job started. Defaults to 1 s for the first
   * 30 s, then 2 s until two minutes, then 5 s.
   */
  pollIntervalMs?: PollInterval;
}

/** Options for `describe(input, options)`. */
export interface DescribeOptions {
  /** Runs this describe job on `client` rather than the default client. */
  client?: Client;
  /** Cancels the describe job when it aborts; it rejects `cancelled` with the abort reason as `cause`. */
  signal?: AbortSignal;
  /** Called once per status poll, as {@link RenderOptions.onProgress} is — a throw included. */
  onProgress?: (status: JobStatusLike) => void;
  /** Milliseconds between status polls; see {@link RenderOptions.pollIntervalMs}. */
  pollIntervalMs?: PollInterval;
}

/** Options for the single-request calls: `status()`, `cancel()` and `listPresets()`. */
export interface RequestOptions {
  /** Sends the request through `client` rather than the default client. */
  client?: Client;
  /** Aborts the request when it fires. */
  signal?: AbortSignal;
}

/** Options for `stage(input, options)`, passed through to `StorageProvider.stageRead`. */
export interface StageOptions {
  /** Stages through `client`'s storage rather than the default client's. */
  client?: Client;
  /** The stored object's key. */
  key?: string;
  /** The stored object's content type. */
  contentType?: string;
  /** How long the returned URL stays valid, in seconds. */
  expiresIn?: number;
  /**
   * Aborts the upload: the provider's `stageRead` is handed it, and the call
   * rejects `cancelled` the moment it aborts, whether or not the provider
   * stops. An already-aborted signal rejects without calling the provider.
   */
  signal?: AbortSignal;
}

/**
 * One of DGR's native presets, as `listPresets()` reports it — the preset's
 * `presetId` plus its human-readable encode summary.
 */
export interface PresetSummary {
  /** The preset's ID — what a spec's `{ presetId }` names, e.g. `'ffs_video_api_land_1080p_hq'`. */
  presetId: string;
  /** Human-readable name, e.g. `'Landscape 1920×1080 – HQ'`. */
  label?: string;
  /** MIME type of the output, e.g. `'video/mp4'`. */
  mediaType?: string;
  /** Video codec, e.g. `'H.264'`. */
  codec?: string;
  /** Codec profile, e.g. `'high'`. */
  profile?: string;
  /** Maximum frames per second, as a fraction. */
  maxFps?: { numerator: number; denominator: number };
  /** Bitrate mode, e.g. `'vbr'`. */
  bitrateMode?: string;
  /** Target bitrate in kilobits per second. */
  targetBitrateInKbps?: number;
  /** Maximum bitrate in kilobits per second. */
  maxBitrateInKbps?: number;
  /** Whether the output carries an alpha channel. */
  alpha?: boolean;
  /** What the preset is meant for, e.g. `'Previews'`. */
  primaryUsage?: string;
}

/**
 * An audio-video client, as {@link createClient} returns it: `render`,
 * `describe`, `listPresets`, `status`, `cancel` and `stage` — the same methods
 * the top-level functions call on the default client — plus the preset
 * catalog (`presets`, `encode`, `resize`). Each client owns its credential,
 * HTTP client, logger and concurrency pool; clients share nothing.
 *
 * @example
 * ```ts
 * const tenant = createClient({ clientId: t.id, clientSecret: t.secret, storage });
 * const asset = await tenant.render(spec);
 * await tenant.render(templateUrl).prores4444xq.save('./out.mov');
 * ```
 */
export interface Client {
  /**
   * Starts a fluent render of the template at `source` — see
   * {@link RenderBuilder}. `source` takes every form a spec's `source` does,
   * read the same way: an http(s) URL is used as it is; a file path, a
   * `file:` URL, a `Buffer` or a `Readable` is uploaded through `storage`
   * once the render holds its pool slot; anything else rejects
   * `invalid_argument`. Nothing is submitted until the builder is awaited or
   * one of its terminals (`buffer()`, `stream()`, `save()`) is called.
   *
   * @example
   * ```ts
   * await client.render(templateUrl).prores4444xq.alpha().save('./out.mov');
   * await client.render('./capsule.mogrt').prores.save('./out.mov');
   * ```
   */
  render(source: TemplateSource, options?: RenderBuilderOptions): RenderBuilder;
  /** Renders `spec` and resolves with its one output's read URL. See the spec overloads for the render itself. */
  render(spec: RenderRequest, options: RenderOptions & { resolveAs: 'url' }): RenderJob<string>;
  /** Renders `spec` and resolves with its one output's bytes. */
  render(spec: RenderRequest, options: RenderOptions & { resolveAs: 'buffer' }): RenderJob<Buffer>;
  /** Renders `spec` and resolves with a byte stream over its one output. */
  render(
    spec: RenderRequest,
    options: RenderOptions & { resolveAs: 'stream' },
  ): RenderJob<Readable>;
  /** Renders `spec`, saves its one output to `savePath`, and resolves with that path. */
  render(
    spec: RenderRequest,
    options: RenderOptions & { resolveAs: 'file'; savePath: string },
  ): RenderJob<string>;
  /**
   * Renders `spec` and resolves with its finished {@link Asset} once the
   * render is done — `asset.url` is the output's `readUrl` (or its
   * `destination` without one; for an output with no `destination`, the read
   * URL `storage` allocated), nothing downloaded yet.
   *
   * Every preset is resolved first — a native match becomes a `presetId`,
   * anything else a generated `.epr` staged through `storage` — and every
   * input is checked before the job asks for a slot. The job then runs inside
   * this client's pool from staging until it settles: every `source`,
   * `assets` entry or `{ url }` preset given as a file, a `Buffer` or a
   * `Readable` is uploaded through `storage`, and every output with no
   * `destination` allocated, once the job holds its slot and just before the
   * submit. The service's `202` carries the
   * `jobId`, `statusUrl` and `cancelUrl`; `statusUrl` is polled until the job
   * is terminal. Every render submit answers with `Retry-After: 1`, `202`
   * included, and only a `429` is retried, so an accepted submit is never
   * delayed.
   *
   * `asset.meta` is the output's own timing. Queue time (`queueMs`) is exact;
   * `renderMs` and `totalMs` are exact for a single-output job, and for an
   * output of a multi-output job are upper bounds, because the service stamps
   * every output of a job complete when the job finishes.
   *
   * @example
   * ```ts
   * const spec: SingleOutputRenderRequest = {
   *   source: capsuleUrl,
   *   presets: ['h264Land1080pHq'],
   *   outputs: [{ presetIndex: 0, destination: writeUrl, readUrl }],
   * };
   * const asset = await render(spec);
   * await asset.save('./out.mp4');
   * ```
   */
  render(
    spec: SingleOutputRenderRequest,
    options?: RenderOptions & { resolveAs?: undefined },
  ): RenderJob<Asset>;
  /**
   * Renders `spec` and resolves with an {@link Asset} when it has exactly one
   * output, or with `Asset[]` in `spec.outputs` order when it has several — so
   * a spec whose `outputs` is not a one-element literal is typed
   * `Asset | Asset[]`. Each asset's URL is its output's `readUrl` (or its
   * `destination` without one, or the read URL `storage` allocated for an
   * output with no `destination`), and its `meta` is that output's own timing
   * (see the single-output overload for how exact it is). The service lists a
   * job's outputs in no particular order; each is matched to its spec output
   * by `variationIndex` and `presetIndex`.
   *
   * @example
   * ```ts
   * const assets = await render(spec); // spec with two outputs
   * if (Array.isArray(assets)) await Promise.all(assets.map((a, i) => a.save(`./out-${i}.mov`)));
   * ```
   */
  render(
    spec: RenderRequest,
    options?: RenderOptions & { resolveAs?: undefined },
  ): RenderJob<Asset | Asset[]>;
  /** Renders `spec`; with a `resolveAs` known only at run time, the result's type is the union of every form. */
  render(
    spec: RenderRequest,
    options?: RenderOptions,
  ): RenderJob<Asset | Asset[] | string | Buffer | Readable>;
  /**
   * Describes a template: submits a describe job, runs it inside this client's
   * pool, and resolves with the template's editable controls and fonts. The
   * template takes every form a render spec's `source` does, read the same
   * way: an http(s) URL is used as it is; a file path, a `file:` URL, a
   * `Buffer` or a `Readable` is uploaded through `storage` once the job holds
   * its pool slot; anything else rejects `invalid_argument`.
   *
   * @example
   * ```ts
   * const { controls } = await client.describe(capsuleUrl);
   * for (const control of controls) console.log(control.variableId, control.type);
   * ```
   */
  describe(input: DescribeInput, options?: DescribeOptions): RenderJob<TemplateDescription>;
  /**
   * Lists DGR's native presets (`GET /v1/presets`). A single request; takes no pool slot.
   *
   * @example
   * ```ts
   * const ids = (await client.listPresets()).map((preset) => preset.presetId);
   * ```
   */
  listPresets(options?: RequestOptions): Promise<PresetSummary[]>;
  /**
   * Reads a job's current status (`GET /v1/status/{jobId}`) — the raw status
   * body. A single request; takes no pool slot.
   *
   * @example
   * ```ts
   * const { status } = await client.status(jobId);
   * ```
   */
  status(jobId: string, options?: RequestOptions): Promise<JobStatusLike>;
  /**
   * Asks the service to stop a render job (`PUT /v1/cancel/{jobId}`) and
   * resolves with its acknowledgement, `{ jobId, status: 'canceling' }`; the
   * job's next status read reports `canceled`. A finished job rejects
   * `http_409`, an unknown one `http_404`. A single request; takes no pool
   * slot. To cancel a render this process started, prefer the handle's own
   * `cancel()`.
   *
   * @example
   * ```ts
   * await client.cancel(jobId);
   * ```
   */
  cancel(jobId: string, options?: RequestOptions): Promise<JobStatusLike>;
  /**
   * Resolves with a URL DGR can read `input` from: an http(s) URL as it is,
   * with no storage call; a `Buffer`, a `Readable` or a local file (a path or
   * a `file:` URL) uploaded through this client's storage, as the presigned
   * read URL it returns. Takes no pool slot. A string that is neither an
   * http(s) URL nor an existing file rejects `invalid_argument`, as does an
   * upload with no `storage` configured. `options.signal` aborts the upload,
   * rejecting `cancelled` at once whether or not the provider stops.
   *
   * @example
   * ```ts
   * const assetUrl = await client.stage(await readFile('./logo.png'), { contentType: 'image/png' });
   * ```
   */
  stage(input: StageInput, options?: StageOptions): Promise<string>;
  /** The named preset catalog — `client.presets.prores4444xq`, … — the same object as the top-level `presets`. */
  readonly presets: typeof presets;
  /** A preset from a full encode config — the same function as the top-level `encode`. */
  readonly encode: typeof encode;
  /** An empty base preset at a fixed frame size — the same function as the top-level `resize`. */
  readonly resize: typeof resize;
}

/**
 * Creates a client with its own credential, HTTP client, logger and
 * concurrency pool. Use one per credential — several tenants, or a library
 * that must not share the default client — and call its methods directly or
 * pass it as `{ client }` to any top-level function.
 *
 * @param config - See {@link ClientConfig}.
 * @returns The client; see {@link Client}.
 * @throws {@link AudioVideoError} `invalid_argument` for an invalid config —
 *   checked here, before any request is made.
 *
 * @example
 * ```ts
 * const tenant = createClient({ clientId: t.id, clientSecret: t.secret });
 * await render(spec, { client: tenant }); // identical to tenant.render(spec)
 * ```
 */
export function createClient(config: ClientConfig): Client {
  return new AudioVideoClient(config) as unknown as Client;
}

/**
 * @internal Normalizes a scope list to the single comma-joined string IMS
 * accepts: a comma- or space-separated string, a JSON-array string, or an
 * array of scope names. An empty list reads as absent.
 *
 * @param source - Names the value in the error message, e.g. `'IMS_OAUTH_S2S_SCOPES'`.
 * @throws {@link AudioVideoError} `invalid_argument` for anything else.
 */
export function normalizeScope(raw: unknown, source: string): string | undefined {
  if (raw === undefined) return undefined;
  let parts: unknown;
  if (Array.isArray(raw)) {
    parts = raw;
  } else if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') return undefined;
    if (text.startsWith('[')) {
      try {
        parts = JSON.parse(text);
      } catch {
        throw invalidScope(source);
      }
    } else {
      parts = text.split(/[\s,]+/);
    }
  } else {
    throw invalidScope(source);
  }
  if (!Array.isArray(parts) || !parts.every((part) => typeof part === 'string')) {
    throw invalidScope(source);
  }
  const scopes = parts.map((part: string) => part.trim()).filter((part) => part !== '');
  return scopes.length > 0 ? scopes.join(',') : undefined;
}

/**
 * @internal The client a `{ client }` option names.
 *
 * @throws {@link AudioVideoError} `invalid_argument` unless it came from {@link createClient}.
 */
export function asClient(value: unknown): AudioVideoClient {
  if (value instanceof AudioVideoClient) return value;
  throw invalidArgument('The client option must be a client created by createClient().');
}

const RENDER_PATH = '/v1/templates/render';
const RENDER_ENDPOINT = 'POST /v1/templates/render';
const DESCRIBE_PATH = '/v1/templates/describe';
const DESCRIBE_ENDPOINT = 'POST /v1/templates/describe';
const PRESETS_PATH = '/v1/presets';
const PRESETS_ENDPOINT = 'GET /v1/presets';
const STATUS_ENDPOINT = 'GET /v1/status/{jobId}';
const CANCEL_ENDPOINT = 'PUT /v1/cancel/{jobId}';
const STAGE_ENDPOINT = 'stage';

const RESOLVE_AS: readonly unknown[] = ['url', 'buffer', 'stream', 'file'] satisfies ResolveAs[];

/**
 * @internal The client behind {@link createClient} and the default client.
 * Application code holds it only as a {@link Client}.
 */
export class AudioVideoClient implements Omit<Client, 'render'>, FluentRenderer {
  readonly presets = presets;
  readonly encode = encode;
  readonly resize = resize;
  readonly #http: HttpClient;
  readonly #logger: Logger | null;
  readonly #pool: PoolBackend;
  readonly #storage: StorageProvider | undefined;

  constructor(config: ClientConfig) {
    if (!isRecord(config)) {
      throw invalidArgument(
        'createClient() expects a config object: { clientId, clientSecret } or { clientId, tokenProvider }.',
      );
    }
    const { clientId } = config;
    if (typeof clientId !== 'string' || clientId.trim() === '') {
      throw invalidArgument('clientId is required: it is sent as x-api-key on every request.');
    }
    const tokenProvider = authFor(config, clientId);
    const maxRetries = config.retry?.maxRetries;
    if (maxRetries !== undefined && !(Number.isInteger(maxRetries) && maxRetries >= 0)) {
      throw invalidArgument('retry.maxRetries must be an integer >= 0.');
    }
    if (config.host !== undefined) hostOrigin(config.host);
    if (config.storage !== undefined && !isStorageProvider(config.storage)) {
      throw invalidArgument('storage must implement stageRead() and allocateOutput().');
    }
    if (
      config.pool !== undefined &&
      typeof (config.pool as { run?: unknown })?.run !== 'function'
    ) {
      throw invalidArgument('pool must implement run().');
    }
    this.#logger = resolveLogger(config.logging);
    this.#pool =
      config.pool ??
      new InMemoryPool(config.concurrency === undefined ? {} : { concurrency: config.concurrency });
    this.#storage = config.storage ?? appBuilderStorage();
    this.#http = new HttpClient({
      apiKey: clientId,
      tokenProvider,
      ...(config.host !== undefined ? { host: config.host } : {}),
      ...(maxRetries !== undefined ? { maxRetries } : {}),
    });
  }

  /** See {@link Client.render}. */
  render(
    input: RenderRequest | TemplateSource,
    options: RenderOptions | RenderBuilderOptions = {},
  ): RenderJob<unknown> | RenderBuilder {
    if (isTemplateSource(input)) {
      const builderOptions = options as RenderBuilderOptions;
      return createRenderBuilder(input, builderOptions, () => this.#target(builderOptions));
    }
    let target: AudioVideoClient;
    try {
      target = this.#targetOrLog(options, 'render', RENDER_ENDPOINT, undefined);
    } catch (error) {
      return rejectedJob(error);
    }
    if (target !== this) return target.render(input, options);
    return this.#renderSpec(input, options as RenderOptions);
  }

  /** See {@link Client.describe}. */
  describe(input: DescribeInput, options: DescribeOptions = {}): RenderJob<TemplateDescription> {
    let target: AudioVideoClient;
    try {
      target = this.#targetOrLog(options, 'describe', DESCRIBE_ENDPOINT, undefined);
    } catch (error) {
      return rejectedJob(error);
    }
    if (target !== this) return target.describe(input, options);
    const progress = trackStatus(options.onProgress);
    return runPooledJob<TemplateDescription, TemplateDescription>({
      pool: this.#pool,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      prepare: async () => {
        const prepared = await prepareDescribe(input, this.#storage);
        return async (signal) => {
          const body = await materializeDescribe(prepared, this.#storage, signal);
          return () =>
            runJob(this.#http, {
              submit: (stop) => this.#submit(DESCRIBE_PATH, body, stop),
              mapResult: (terminal) => describeResult(terminal),
              onProgress: progress.onProgress,
              ...jobTuning(options),
            });
        };
      },
      finish: (description) => description,
      onSettle: (outcome, job) => {
        const terminal = job?.meta !== undefined ? progress.last : undefined;
        this.#log({
          ...settleFields('describe', outcome),
          endpoint: DESCRIBE_ENDPOINT,
          jobId: job?.jobId,
          meta: job?.meta,
          status: terminal?.status,
        });
      },
    });
  }

  /** See {@link Client.listPresets}. */
  async listPresets(options: RequestOptions = {}): Promise<PresetSummary[]> {
    const target = this.#targetOrLog(options, 'list presets', PRESETS_ENDPOINT, undefined);
    if (target !== this) return target.listPresets(options);
    return this.#logged('list presets', PRESETS_ENDPOINT, undefined, options.signal, async () => {
      const res = await this.#http.request<unknown>(
        'GET',
        PRESETS_PATH,
        undefined,
        signalInit(options.signal),
      );
      return presetItems(res.body);
    });
  }

  /** See {@link Client.status}. */
  async status(jobId: string, options: RequestOptions = {}): Promise<JobStatusLike> {
    const target = this.#targetOrLog(options, 'status', STATUS_ENDPOINT, jobIdField(jobId));
    if (target !== this) return target.status(jobId, options);
    return this.#logged(
      'status',
      STATUS_ENDPOINT,
      jobIdField(jobId),
      options.signal,
      async () => {
        const id = requireJobId(jobId, 'status');
        const res = await this.#http.request<unknown>(
          'GET',
          `/v1/status/${encodeURIComponent(id)}`,
          undefined,
          signalInit(options.signal),
        );
        if (!isRecord(res.body)) {
          throw new AudioVideoError({
            message: `The ${STATUS_ENDPOINT} response was not a JSON object.`,
            code: 'invalid_response',
            status: res.status,
          });
        }
        return res.body as JobStatusLike;
      },
      (body) => ({ status: body.status, totalJobItems: itemCount(body) }),
    );
  }

  /** See {@link Client.cancel}. */
  async cancel(jobId: string, options: RequestOptions = {}): Promise<JobStatusLike> {
    const target = this.#targetOrLog(options, 'cancel', CANCEL_ENDPOINT, jobIdField(jobId));
    if (target !== this) return target.cancel(jobId, options);
    return this.#logged(
      'cancel',
      CANCEL_ENDPOINT,
      jobIdField(jobId),
      options.signal,
      async () => {
        const id = requireJobId(jobId, 'cancel');
        const res = await this.#http.request<unknown>(
          'PUT',
          `/v1/cancel/${encodeURIComponent(id)}`,
          undefined,
          signalInit(options.signal),
        );
        return { jobId: id, ...(isRecord(res.body) ? res.body : {}) } as JobStatusLike;
      },
      (body) => ({ status: body.status }),
    );
  }

  /** See {@link Client.stage}. */
  async stage(input: StageInput, options: StageOptions = {}): Promise<string> {
    const target = this.#targetOrLog(options, 'stage', STAGE_ENDPOINT, undefined);
    if (target !== this) return target.stage(input, options);
    const { key, contentType, expiresIn, signal } = options;
    return this.#logged('stage', STAGE_ENDPOINT, undefined, signal, () => {
      signal?.throwIfAborted();
      const staged = normalizeAsset(input, this.#storage, { key, contentType, expiresIn, signal });
      return signal === undefined ? staged : untilAborted(staged, signal);
    });
  }

  /** @internal Starts a fluent render; see {@link FluentRenderer}. */
  startFluentRender(input: FluentRenderInput, options: RenderBuilderOptions): RenderJob<Asset> {
    let prepared: PreparedRender | undefined;
    const progress = trackStatus(options.onProgress);
    return runPooledJob<Asset[], Asset>({
      pool: this.#pool,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      prepare: async () => {
        prepared = await prepareFluent(input, this.#storage);
        return this.#renderStage(prepared, options, progress);
      },
      finish: (assets) => onlyAsset(assets),
      onSettle: (outcome, job) => this.#logRender(outcome, job, prepared, progress.last),
    });
  }

  #renderSpec(request: RenderRequest, options: RenderOptions): RenderJob<unknown> {
    let prepared: PreparedRender | undefined;
    const progress = trackStatus(options.onProgress);
    return runPooledJob<Asset[], unknown>({
      pool: this.#pool,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      prepare: async () => {
        checkResolveAs(options);
        prepared = await prepareRequest(request, this.#storage);
        if (options.resolveAs !== undefined && prepared.outputs.length !== 1) {
          throw invalidArgument(
            `resolveAs applies to a render with exactly one output, and this spec has ` +
              `${prepared.outputs.length}: resolve each asset yourself.`,
          );
        }
        return this.#renderStage(prepared, options, progress);
      },
      finish: (assets, signal) => {
        if (assets.length !== 1) return assets;
        const asset = onlyAsset(assets);
        const { resolveAs, savePath } = options;
        if (resolveAs === undefined) return asset;
        return resolveAsset(asset, {
          resolveAs,
          ...(savePath !== undefined ? { savePath } : {}),
          signal,
        });
      },
      onSettle: (outcome, job) => this.#logRender(outcome, job, prepared, progress.last),
    });
  }

  /**
   * A render's work inside its pool slot: uploads its inputs, stages its
   * generated `.epr` files and allocates its outputs once the job holds the
   * slot — `signal` aborts them — then resolves with the function that
   * submits it.
   */
  #renderStage(
    prepared: PreparedRender,
    options: RenderOptions | RenderBuilderOptions,
    progress: StatusTracker,
  ): StageJob<Asset[]> {
    return async (signal) => {
      const { body, outputs } = await materializeRender(prepared, this.#storage, signal);
      return () =>
        runJob(this.#http, {
          submit: (stop) => this.#submit(RENDER_PATH, body, stop),
          mapResult: (terminal, meta) => renderAssets(terminal, meta, outputs),
          onProgress: progress.onProgress,
          ...jobTuning(options),
        });
    };
  }

  /**
   * Submits a job and returns its ID and status URL. The service's `202` body
   * carries `jobId`, `statusUrl` and `cancelUrl`; the cancel request goes to
   * `/v1/cancel/{jobId}`, which is what `cancelUrl` names. `stop` ends the
   * submit wherever no attempt is in flight — a `429` created no job — and
   * never aborts one already sent.
   */
  async #submit(path: string, body: unknown, stop: AbortSignal): Promise<JobSubmission> {
    const res = await this.#http.request<unknown>('POST', path, body, { stopSignal: stop });
    const { jobId, statusUrl } = isRecord(res.body) ? res.body : {};
    if (typeof jobId !== 'string' || jobId === '' || typeof statusUrl !== 'string' || !statusUrl) {
      throw new AudioVideoError({
        message: `The POST ${path} response carried no jobId and statusUrl.`,
        code: 'submit_failed',
        status: res.status,
      });
    }
    return { jobId, statusUrl };
  }

  #logRender(
    outcome: PooledJobOutcome<unknown>,
    job: AsyncJob<Asset[]> | undefined,
    prepared: PreparedRender | undefined,
    last: JobStatusLike | undefined,
  ): void {
    const terminal = job?.meta !== undefined ? last : undefined;
    this.#log({
      ...settleFields('render', outcome),
      endpoint: RENDER_ENDPOINT,
      jobId: job?.jobId,
      meta: job?.meta,
      ...presetLogFields(prepared?.presets ?? []),
      totalJobItems: itemCount(terminal) ?? (outcome.ok ? prepared?.outputs.length : undefined),
      status: terminal?.status,
    });
  }

  /**
   * Runs one single-request call and logs exactly one record when it
   * settles. Anything `run` throws that is not already an
   * {@link AudioVideoError} is wrapped as one before it is logged and
   * rethrown — see {@link publicFailure}.
   */
  async #logged<T>(
    action: string,
    endpoint: string,
    jobId: string | undefined,
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
    detail?: (value: T) => Pick<BuildLogRecordInput, 'status' | 'totalJobItems'>,
  ): Promise<T> {
    let value: T;
    try {
      value = await run();
    } catch (raw) {
      const error = publicFailure(raw, signal);
      this.#log({ ...settleFields(action, { ok: false, error }), endpoint, jobId });
      throw error;
    }
    this.#log({
      ...settleFields(action, { ok: true, value }),
      endpoint,
      jobId,
      ...detail?.(value),
    });
    return value;
  }

  #log(input: BuildLogRecordInput): void {
    emit(this.#logger, buildLogRecord(input));
  }

  #target(options: { client?: Client } | undefined): AudioVideoClient {
    const client = options?.client;
    return client === undefined ? this : asClient(client);
  }

  /**
   * {@link AudioVideoClient.#target}, logging one record on this client when
   * the named `{ client }` is invalid — the only client such a call could
   * ever reach, since the named one never resolved.
   */
  #targetOrLog(
    options: { client?: Client } | undefined,
    action: string,
    endpoint: string,
    jobId: string | undefined,
  ): AudioVideoClient {
    try {
      return this.#target(options);
    } catch (error) {
      this.#log({ ...settleFields(action, { ok: false, error }), endpoint, jobId });
      throw error;
    }
  }

  /** @internal Logs a fluent render as cancelled before it reached this client; see {@link FluentRenderer.logCancelled}. */
  logCancelled(error: AudioVideoError): void {
    this.#log({ ...settleFields('render', { ok: false, error }), endpoint: RENDER_ENDPOINT });
  }
}

/** The last status body a job's polls returned, and the poll callback that records it. */
interface StatusTracker {
  last: JobStatusLike | undefined;
  readonly onProgress: (status: JobStatusLike) => void;
}

/** A {@link StatusTracker} that also forwards each status body to `forward`. */
function trackStatus(forward: ((status: JobStatusLike) => void) | undefined): StatusTracker {
  const tracker: StatusTracker = {
    last: undefined,
    onProgress: (status) => {
      tracker.last = status;
      forward?.(status);
    },
  };
  return tracker;
}

/** The job-runner options a render or describe call passes through. */
function jobTuning(options: { signal?: AbortSignal; pollIntervalMs?: PollInterval }): {
  signal?: AbortSignal;
  pollIntervalMs?: PollInterval;
} {
  return {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
  };
}

/** The level, message and error a call's record carries for how it settled. */
function settleFields(
  action: string,
  outcome: PooledJobOutcome<unknown>,
): Pick<BuildLogRecordInput, 'level' | 'msg' | 'error'> {
  if (outcome.ok) return { level: 'info', msg: `${action} completed` };
  const { error } = outcome;
  if (error instanceof AudioVideoError && error.code === 'cancelled') {
    return { level: 'warn', msg: `${action} cancelled`, error };
  }
  return { level: 'error', msg: `${action} failed`, error };
}

/**
 * Everything a single-request call promises to reject with: an
 * {@link AudioVideoError} unchanged, or anything else — a raw fetch failure,
 * an abort reason `HttpClient` does not wrap — as one, whose `cause` is a
 * redacted copy of the original ({@link redactError}), never the original
 * itself. `code` is `'cancelled'` when `signal` is why it failed, else
 * `'request_failed'`.
 */
function publicFailure(error: unknown, signal: AbortSignal | undefined): AudioVideoError {
  if (error instanceof AudioVideoError) return error;
  const aborted = signal?.aborted ?? false;
  return new AudioVideoError({
    message: aborted ? 'The request was cancelled.' : 'The request failed.',
    code: aborted ? 'cancelled' : 'request_failed',
    cause: redactError(error),
  });
}

/** Checks a `resolveAs` value a caller outside TypeScript may have passed. */
function checkResolveAs(options: RenderOptions): void {
  const { resolveAs, savePath } = options;
  if (resolveAs === undefined) return;
  if (!RESOLVE_AS.includes(resolveAs)) {
    throw invalidArgument("resolveAs must be 'url', 'buffer', 'stream' or 'file'.");
  }
  if (resolveAs === 'file' && (typeof savePath !== 'string' || savePath === '')) {
    throw invalidArgument("resolveAs: 'file' requires a savePath.");
  }
}

function onlyAsset(assets: readonly Asset[]): Asset {
  const [asset] = assets;
  if (assets.length !== 1 || asset === undefined) {
    throw new AudioVideoError({
      message: `Expected exactly one rendered asset, got ${assets.length}.`,
      code: 'invalid_response',
    });
  }
  return asset;
}

/** The token provider a config authenticates with. */
function authFor(config: ClientConfig, clientId: string): TokenProvider {
  const { clientSecret, scope, tokenProvider } = config;
  if (tokenProvider !== undefined) {
    if (typeof (tokenProvider as { getAccessToken?: unknown })?.getAccessToken !== 'function') {
      throw invalidArgument('tokenProvider must have a getAccessToken() method.');
    }
    if (clientSecret !== undefined) {
      throw invalidArgument('Pass either clientSecret or tokenProvider, not both.');
    }
    if (scope !== undefined) {
      throw invalidArgument(
        'scope applies only to clientSecret authentication; a tokenProvider supplies its own tokens.',
      );
    }
    return tokenProvider;
  }
  if (typeof clientSecret !== 'string' || clientSecret === '') {
    throw invalidArgument('clientSecret is required unless a tokenProvider is given.');
  }
  const normalized = normalizeScope(scope, 'scope');
  return resolveTokenProvider({
    clientId,
    clientSecret,
    ...(normalized !== undefined ? { scope: normalized } : {}),
  });
}

function isStorageProvider(value: unknown): value is StorageProvider {
  return (
    isRecord(value) &&
    typeof value.stageRead === 'function' &&
    typeof value.allocateOutput === 'function'
  );
}

function invalidScope(source: string): AudioVideoError {
  return invalidArgument(
    `${source} must be a comma-separated scope list or a JSON array of scope names, ` +
      'e.g. openid,AdobeID,firefly_api,ff_apis.',
  );
}

/** `GET /v1/presets` lists its presets under `items`. */
function presetItems(body: unknown): PresetSummary[] {
  const items = isRecord(body) ? body.items : body;
  if (!Array.isArray(items)) {
    throw new AudioVideoError({
      message: `The ${PRESETS_ENDPOINT} response carried no items list.`,
      code: 'invalid_response',
    });
  }
  return items.filter(
    (item: unknown): item is PresetSummary => isRecord(item) && typeof item.presetId === 'string',
  );
}

function requireJobId(jobId: unknown, action: string): string {
  if (typeof jobId !== 'string' || jobId.trim() === '') {
    throw invalidArgument(`${action}() requires a job ID.`);
  }
  return jobId.trim();
}

/** A job ID for a log record — only a non-empty string is one. */
function jobIdField(jobId: unknown): string | undefined {
  return typeof jobId === 'string' && jobId.trim() !== '' ? jobId.trim() : undefined;
}

function itemCount(status: JobStatusLike | undefined): number | undefined {
  const count = (status as { totalJobItems?: unknown } | undefined)?.totalJobItems;
  return typeof count === 'number' && Number.isFinite(count) ? count : undefined;
}

function signalInit(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal !== undefined ? { signal } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
