/**
 * The default client and the top-level functions that use it. The default
 * client is the one the last `configure()` call installed; without one, the
 * first top-level call creates it from the environment. A call given
 * `{ client }` runs on that client alone and neither creates nor touches the
 * default.
 */

import { rejectedJob } from '../core/pooled-job.js';
import type { StageInput } from '../core/storage.js';
import type { JobStatusLike } from '../core/job.js';
import { createRenderBuilder, type RenderBuilderOptions } from './builder.js';
import {
  AudioVideoClient,
  asClient,
  normalizeScope,
  type Client,
  type ClientConfig,
  type DescribeOptions,
  type PresetSummary,
  type RenderJob,
  type RenderOptions,
  type RequestOptions,
  type StageOptions,
} from './client.js';
import type { DescribeInput, TemplateDescription } from './describe.js';
import { invalidArgument, isTemplateSource } from './render.js';
import type { RenderRequest } from './schemas.js';

let defaultClient: AudioVideoClient | undefined;

/**
 * Installs the default client every top-level function uses. The config is
 * checked at once; the last call wins, and a job already running keeps the
 * client it started on. Use {@link createClient} instead for several
 * credentials, or inside a library.
 *
 * @param config - See {@link ClientConfig}.
 * @throws {@link AudioVideoError} `invalid_argument` for an invalid config;
 *   the previous default client stays in place.
 *
 * @example
 * ```ts
 * configure({ clientId, clientSecret, storage, logging: 'warn', concurrency: 10 });
 * const asset = await render(spec);
 * ```
 */
export function configure(config: ClientConfig): void {
  defaultClient = new AudioVideoClient(config);
}

/**
 * Drops the default client, so the next top-level call creates one from the
 * environment again (or rejects when the environment names no credentials).
 * Meant for tests.
 *
 * @example
 * ```ts
 * afterEach(() => resetDefaultClient());
 * ```
 */
export function resetDefaultClient(): void {
  defaultClient = undefined;
}

/**
 * Renders on the default client — or on `options.client` — with every form
 * {@link Client.render} takes: a spec resolves with its finished `Asset`
 * (`Asset[]` for several outputs, or the `resolveAs` form); a template URL
 * starts a fluent {@link RenderBuilder}.
 *
 * Without `configure()`, the first call creates the default client from
 * `IMS_OAUTH_S2S_CLIENT_ID`, `IMS_OAUTH_S2S_CLIENT_SECRET` and the optional
 * `IMS_OAUTH_S2S_SCOPES`; with none of them set it rejects `invalid_argument`.
 * Many renders need no batch API: loop over `render()` and the client's pool
 * bounds how many run at once.
 *
 * @example
 * ```ts
 * const asset = await render(spec);
 * await render(templateUrl).prores4444xq.alpha().save('./out.mov');
 * const assets = await Promise.all(specs.map((s) => render(s)));
 * await render(spec, { client: tenant });
 * ```
 */
export const render = ((input: unknown, options?: RenderOptions | RenderBuilderOptions) => {
  if (isTemplateSource(input)) {
    return createRenderBuilder(input, options ?? {}, () => clientFor(options));
  }
  let client: AudioVideoClient;
  try {
    client = clientFor(options);
  } catch (error) {
    return rejectedJob(error);
  }
  return client.render(input as RenderRequest, options);
}) as Client['render'];

/**
 * Describes a template on the default client — or on `options.client` — and
 * resolves with its editable controls and fonts. See {@link Client.describe}.
 *
 * @example
 * ```ts
 * const { controls, fonts } = await describe(capsuleUrl);
 * ```
 */
export function describe(
  input: DescribeInput,
  options?: DescribeOptions,
): RenderJob<TemplateDescription> {
  let client: AudioVideoClient;
  try {
    client = clientFor(options);
  } catch (error) {
    return rejectedJob(error);
  }
  return client.describe(input, options);
}

/**
 * Lists DGR's native presets on the default client — or on `options.client`.
 * See {@link Client.listPresets}.
 *
 * @example
 * ```ts
 * const list = await listPresets();
 * ```
 */
export async function listPresets(options?: RequestOptions): Promise<PresetSummary[]> {
  return clientFor(options).listPresets(options);
}

/**
 * Reads a job's status on the default client — or on `options.client`. See
 * {@link Client.status}.
 *
 * @example
 * ```ts
 * const { status: state } = await status(jobId);
 * ```
 */
export async function status(jobId: string, options?: RequestOptions): Promise<JobStatusLike> {
  return clientFor(options).status(jobId, options);
}

/**
 * Asks the service to stop a render job, on the default client — or on
 * `options.client`. See {@link Client.cancel}.
 *
 * @example
 * ```ts
 * await cancel(jobId);
 * ```
 */
export async function cancel(jobId: string, options?: RequestOptions): Promise<JobStatusLike> {
  return clientFor(options).cancel(jobId, options);
}

/**
 * Resolves with a URL DGR can read `input` from, on the default client — or
 * on `options.client`: an http(s) URL as it is, anything else uploaded
 * through that client's storage. See {@link Client.stage}.
 *
 * @example
 * ```ts
 * const url = await stage(buffer, { contentType: 'image/png' });
 * ```
 */
export async function stage(input: StageInput, options?: StageOptions): Promise<string> {
  return clientFor(options).stage(input, options);
}

/** The client a top-level call runs on: `options.client`, else the default, created on first use. */
function clientFor(options: { client?: Client } | undefined): AudioVideoClient {
  if (options?.client !== undefined) return asClient(options.client);
  defaultClient ??= new AudioVideoClient(configFromEnvironment());
  return defaultClient;
}

/**
 * The default client's config from `IMS_OAUTH_S2S_CLIENT_ID`,
 * `IMS_OAUTH_S2S_CLIENT_SECRET` and the optional `IMS_OAUTH_S2S_SCOPES` —
 * which aio-generated `.env` files store as a JSON-array string, normalized
 * here to the comma-joined string IMS accepts.
 *
 * @throws {@link AudioVideoError} `invalid_argument` naming both ways to
 *   configure when the credentials are not set.
 */
function configFromEnvironment(): ClientConfig {
  const clientId = process.env.IMS_OAUTH_S2S_CLIENT_ID?.trim();
  const clientSecret = process.env.IMS_OAUTH_S2S_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    const missing = [
      clientId ? undefined : 'IMS_OAUTH_S2S_CLIENT_ID',
      clientSecret ? undefined : 'IMS_OAUTH_S2S_CLIENT_SECRET',
    ].filter((name) => name !== undefined);
    throw invalidArgument(
      'No client is configured: call configure({ clientId, clientSecret }) once, or set ' +
        'IMS_OAUTH_S2S_CLIENT_ID and IMS_OAUTH_S2S_CLIENT_SECRET (and optionally ' +
        `IMS_OAUTH_S2S_SCOPES) in the environment. Not set: ${missing.join(', ')}.`,
    );
  }
  const scope = normalizeScope(process.env.IMS_OAUTH_S2S_SCOPES, 'IMS_OAUTH_S2S_SCOPES');
  return { clientId, clientSecret, ...(scope !== undefined ? { scope } : {}) };
}
