/**
 * Live smoke: real renders against the audio/video API, one per codec path,
 * each saved to disk and checked by the FourCC of its video sample entry. Runs
 * under `npm run smoke` only — never under `npm test` or CI — and only when
 * IMS_OAUTH_S2S_CLIENT_ID is set; every render it submits is billed.
 *
 * Environment:
 * - IMS_OAUTH_S2S_CLIENT_ID, IMS_OAUTH_S2S_CLIENT_SECRET, and optionally
 *   IMS_OAUTH_S2S_SCOPES: the server-to-server credential.
 * - DGR_SMOKE_ORG: the IMS org that credential must belong to. The access
 *   token's `org` claim is checked against it before anything is staged or
 *   rendered: a render under the wrong credential bills another tenancy and
 *   still succeeds.
 * - AIO_runtime_namespace, AIO_runtime_auth: the App Builder Files store every
 *   input is staged in and every output is written to.
 * - DGR_SMOKE_TEMPLATE: a short `.mogrt` — a local path, staged through that
 *   store, or an http(s) URL.
 * - DGR_SMOKE_OUT_DIR (optional): where the rendered files are saved; a new
 *   temporary directory otherwise. Nothing saved there is deleted.
 * - DGR_SMOKE_S3 (`s3://<bucket>/<prefix>`, AWS default credential chain) and
 *   DGR_SMOKE_AZURE (`azure://<container>/<prefix>`, with
 *   AZURE_STORAGE_CONNECTION_STRING), each optional: one more render staged and
 *   written through that store. The bucket or container must already exist.
 *
 * Every object a run writes gets a key under a new `smoke-<yyyymmdd>-<id>/`
 * prefix, recorded before the write, and is deleted after the last test; each
 * deletion is proven by a read that reports the key absent, next to a
 * never-written key the same read also reports absent.
 *
 * App Builder log forwarding: Splunk and New Relic parse the NDJSON records the
 * client writes into fields; whether Azure Log Analytics splits their JSON keys
 * into columns is unverified.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { normalizeScope } from '../../src/dgr/client.js';
import {
  AioFilesStorageProvider,
  AzureBlobStorageProvider,
  ClientCredentialsProvider,
  S3StorageProvider,
  createClient,
  type Client,
  type PresetName,
  type StageInput,
  type StorageProvider,
} from '../../src/index.js';
import { videoSampleEntry } from './fourcc.js';

/** One render per codec path: DGR's native ProRes preset, and the two presets the client generates as `.epr` files. */
const CODEC_LEGS = [
  { preset: 'prores', fourcc: 'ap4h', extension: '.mov' },
  { preset: 'prores4444xq', fourcc: 'ap4x', extension: '.mov' },
  { preset: 'hevc1080p10bit', fourcc: 'hvc1', extension: '.mp4' },
] as const satisfies readonly { preset: PresetName; fourcc: string; extension: string }[];

/** What the S3 and Azure legs render: the native ProRes preset, so each leg tests only its store. */
const STORE_LEG = CODEC_LEGS[0];

const REQUIRED = [
  'IMS_OAUTH_S2S_CLIENT_SECRET',
  'DGR_SMOKE_ORG',
  'AIO_runtime_namespace',
  'AIO_runtime_auth',
  'DGR_SMOKE_TEMPLATE',
] as const;

/** The key prefix every object of this run goes under. */
const RUN_PREFIX = `smoke-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(4).toString('hex')}/`;

/** A store the run writes to: the provider the client stages through, and how to read and delete one of its objects. */
interface SmokeStore {
  readonly name: string;
  /** The prefix every key of this run goes under in this store. */
  readonly prefix: string;
  /** Every object key the run wrote here, recorded before the write. */
  readonly keys: string[];
  readonly storage: StorageProvider;
  /** Set once a render through this store has saved its output. */
  rendered: boolean;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
}

describe.skipIf(!process.env.IMS_OAUTH_S2S_CLIENT_ID)('live render round trip', () => {
  const stores: SmokeStore[] = [];
  let tokens: ClientCredentialsProvider;
  let template: string;
  let outDir: string;
  let files: SmokeStore;
  let client: Client;

  beforeAll(async () => {
    const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
    if (missing.length > 0) {
      throw new Error(`The live smoke needs ${missing.join(', ')} in the environment.`);
    }
    const clientId = env('IMS_OAUTH_S2S_CLIENT_ID');
    const scope = normalizeScope(process.env.IMS_OAUTH_S2S_SCOPES, 'IMS_OAUTH_S2S_SCOPES');
    tokens = new ClientCredentialsProvider({
      clientId,
      clientSecret: env('IMS_OAUTH_S2S_CLIENT_SECRET'),
      ...(scope !== undefined ? { scope } : {}),
    });
    const expected = env('DGR_SMOKE_ORG');
    const org = orgClaim(await tokens.getAccessToken());
    if (org !== expected) {
      throw new Error(
        `The credential's access token names IMS org ${org ?? '(none)'}, not DGR_SMOKE_ORG ` +
          `${expected}: refusing to stage or render anything.`,
      );
    }
    template = env('DGR_SMOKE_TEMPLATE');
    outDir = process.env.DGR_SMOKE_OUT_DIR?.trim() || mkdtempSync(join(tmpdir(), 'fav-smoke-'));
    mkdirSync(outDir, { recursive: true });
    console.info(`Renders are saved in ${outDir}; objects go under ${RUN_PREFIX}`);
    files = await aioFilesStore();
    stores.push(files);
    client = clientFor(files);
  });

  afterAll(async () => {
    const failures: string[] = [];
    for (const store of stores) failures.push(...(await sweep(store)));
    expect(failures).toEqual([]);
  });

  test.for(CODEC_LEGS)(
    '$preset renders through App Builder Files to a file whose video sample entry is $fourcc',
    async (leg, { signal }) => {
      await renderAndCheck(client, files, leg, leg.preset, signal);
    },
  );

  test('S3: a render staged in and written to S3StorageProvider', async ({ signal, skip }) => {
    const target = process.env.DGR_SMOKE_S3?.trim();
    if (!target) return skip('DGR_SMOKE_S3 is not set (s3://<bucket>/<prefix>)');
    const store = await s3Store(target);
    stores.push(store);
    await renderAndCheck(clientFor(store), store, STORE_LEG, 's3', signal);
  });

  test('Azure: a render staged in and written to AzureBlobStorageProvider', async ({
    signal,
    skip,
  }) => {
    const target = process.env.DGR_SMOKE_AZURE?.trim();
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING?.trim();
    if (!target) return skip('DGR_SMOKE_AZURE is not set (azure://<container>/<prefix>)');
    if (!connectionString) {
      return skip('DGR_SMOKE_AZURE is set but AZURE_STORAGE_CONNECTION_STRING is not');
    }
    const store = await azureStore(target, connectionString);
    stores.push(store);
    await renderAndCheck(clientFor(store), store, STORE_LEG, 'azure', signal);
  });

  /** A client on the proven credential that stages through `store`; a `429` is not retried, so each render is one submit. */
  function clientFor(store: SmokeStore): Client {
    return createClient({
      clientId: env('IMS_OAUTH_S2S_CLIENT_ID'),
      tokenProvider: tokens,
      storage: store.storage,
      retry: { maxRetries: 0 },
    });
  }

  /** Renders the template with `leg.preset` through `on`, saves the output, and checks its size and FourCC. */
  async function renderAndCheck(
    on: Client,
    store: SmokeStore,
    leg: (typeof CODEC_LEGS)[number],
    name: string,
    signal: AbortSignal,
  ): Promise<void> {
    const path = join(outDir, `${name}${leg.extension}`);
    // The service refuses a render with no `variations` (422), so the spec carries one variation
    // that overrides nothing: every control keeps the template's default.
    const asset = await on.render(
      {
        source: template,
        presets: [leg.preset],
        variations: [{ variables: [] }],
        outputs: [{ presetIndex: 0 }],
      },
      { signal },
    );
    await asset.save(path, { signal });
    store.rendered = true;
    const bytes = statSync(path).size;
    const found = await videoSampleEntry(path);
    const { jobId, queueMs, renderMs, totalMs } = asset.meta;
    console.info(
      `${name}: job ${jobId}, preset ${leg.preset}, FourCC requested ${leg.fourcc} found ${found}, ` +
        `queue ${queueMs} ms, render ${renderMs} ms, total ${totalMs} ms, ${bytes} bytes`,
    );
    expect(bytes).toBeGreaterThan(0);
    expect(found).toBe(leg.fourcc);
  }

  /** The App Builder Files store the Runtime credentials in the environment name. */
  async function aioFilesStore(): Promise<SmokeStore> {
    const keys: string[] = [];
    const filesLib = await import('@adobe/aio-lib-files');
    const files = await filesLib.init({
      ow: { namespace: env('AIO_runtime_namespace'), auth: env('AIO_runtime_auth') },
    });
    /** The status a presigned `method` request for `key` answers; the URL itself never leaves this function. */
    const statusOf = async (key: string, method: 'HEAD' | 'DELETE'): Promise<number> => {
      const url = await files.generatePresignURL(key, {
        expiryInSeconds: 600,
        permissions: method === 'HEAD' ? 'r' : 'd',
        urlType: 'external',
      });
      const res = await fetch(url, { method });
      await res.body?.cancel();
      return res.status;
    };
    return {
      name: 'App Builder Files',
      prefix: RUN_PREFIX,
      keys,
      storage: recording(new AioFilesStorageProvider({ prefix: RUN_PREFIX }), RUN_PREFIX, keys),
      rendered: false,
      async exists(key) {
        const status = await statusOf(key, 'HEAD');
        if (status === 200 || status === 404) return status === 200;
        throw new Error(`Reading ${key} answered ${status}.`);
      },
      async remove(key) {
        const status = await statusOf(key, 'DELETE');
        if (status !== 202) throw new Error(`Deleting ${key} answered ${status}.`);
      },
    };
  }
});

/** An S3 store: `s3://<bucket>/<prefix>`, on the AWS SDK's default credential chain. */
async function s3Store(target: string): Promise<SmokeStore> {
  const { root, prefix: base } = parseTarget(target, 's3:');
  const prefix = `${base}${RUN_PREFIX}`;
  const keys: string[] = [];
  const { S3Client, HeadObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({});
  return {
    name: `S3 bucket ${root}`,
    prefix,
    keys,
    storage: recording(new S3StorageProvider({ bucket: root, prefix }), prefix, keys),
    rendered: false,
    async exists(key) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: root, Key: key }));
        return true;
      } catch (error) {
        if (
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
        ) {
          return false;
        }
        throw error;
      }
    },
    async remove(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: root, Key: key }));
    },
  };
}

/** An Azure Blob store: `azure://<container>/<prefix>`, on a connection string holding the account key. */
async function azureStore(target: string, connectionString: string): Promise<SmokeStore> {
  const { root, prefix: base } = parseTarget(target, 'azure:');
  const prefix = `${base}${RUN_PREFIX}`;
  const keys: string[] = [];
  const { BlobServiceClient } = await import('@azure/storage-blob');
  const container =
    BlobServiceClient.fromConnectionString(connectionString).getContainerClient(root);
  return {
    name: `Azure container ${root}`,
    prefix,
    keys,
    storage: recording(
      new AzureBlobStorageProvider({ container: root, connectionString, prefix }),
      prefix,
      keys,
    ),
    rendered: false,
    exists: (key) => container.getBlockBlobClient(key).exists(),
    async remove(key) {
      await container.getBlockBlobClient(key).delete();
    },
  };
}

/**
 * Deletes every object the run recorded in `store` and reads each one back,
 * returning a line for anything still present or unreadable. A never-written
 * key must read as absent too, and after a render at least one recorded key
 * must have read as present before its deletion — otherwise an "absent"
 * answer proves nothing.
 */
async function sweep(store: SmokeStore): Promise<string[]> {
  const failures: string[] = [];
  let present = 0;
  for (const key of store.keys) {
    try {
      if (await store.exists(key)) {
        present += 1;
        await store.remove(key);
      }
      if (await store.exists(key)) failures.push(`${store.name}: ${key} is still present.`);
    } catch (error) {
      failures.push(`${store.name}: ${key}: ${(error as Error).message}`);
    }
  }
  const control = `${store.prefix}never-written`;
  try {
    if (await store.exists(control))
      failures.push(`${store.name}: never-written ${control} reads as present.`);
  } catch (error) {
    failures.push(`${store.name}: ${control}: ${(error as Error).message}`);
  }
  if (store.rendered && present === 0) {
    failures.push(`${store.name}: no recorded key read as present before deletion.`);
  }
  console.info(
    `${store.name}: ${store.keys.length} keys under ${store.prefix}; ${present} present and deleted, ` +
      `${store.keys.length - present} never written; ${failures.length} failures; ` +
      `never-written control key checked`,
  );
  return failures;
}

/**
 * `provider` with every object it writes given a key recorded in `keys` (as
 * `prefix` plus that key) before the write starts, so cleanup finds it even if
 * the write fails part-way. `provider` must be configured with `prefix`.
 */
function recording(provider: StorageProvider, prefix: string, keys: string[]): StorageProvider {
  let count = 0;
  const claim = (key: string | undefined, name: string): string => {
    count += 1;
    const chosen = key ?? `${String(count).padStart(2, '0')}-${name}`;
    keys.push(`${prefix}${chosen}`);
    return chosen;
  };
  return {
    stageRead: (input, opts = {}) =>
      provider.stageRead(input, {
        ...opts,
        key: claim(opts.key, stagedName(input, opts.contentType)),
      }),
    allocateOutput: (opts = {}) =>
      provider.allocateOutput({ ...opts, key: claim(opts.key, 'output') }),
  };
}

/** A readable name for a staged object: the file's own name, or what a buffer holds. */
function stagedName(input: StageInput, contentType: string | undefined): string {
  if (typeof input === 'string') return basename(input);
  if (input instanceof URL) return basename(input.pathname);
  return contentType === 'application/xml' ? 'preset.epr' : 'input';
}

/** The bucket or container, and the key prefix (ending `/`, or empty), of a `s3://` or `azure://` target. */
function parseTarget(target: string, protocol: 's3:' | 'azure:'): { root: string; prefix: string } {
  const url = new URL(target);
  if (url.protocol !== protocol || url.hostname === '') {
    throw new Error(`Expected ${protocol}//<name>/<prefix>, got ${target}.`);
  }
  const path = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  return { root: url.hostname, prefix: path === '' || path.endsWith('/') ? path : `${path}/` };
}

/** The IMS org a JWT access token names in its `org` claim, or `undefined` when it names none. */
function orgClaim(token: string): string | undefined {
  const payload = token.split('.')[1];
  if (payload === undefined) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const org = (claims as { org?: unknown } | null)?.org;
    return typeof org === 'string' ? org : undefined;
  } catch {
    return undefined;
  }
}

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}
