/**
 * Two copies of the package in one process — what an application gets when it
 * imports the ESM build while a CommonJS dependency requires the CommonJS
 * build — share one default client and one identity for every exported
 * class. The second copy here is the source loaded again under a fresh module
 * registry, so every module in it, and every class, is a separate instance.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import * as first from '../src/index.js';
import { API, MockApi, STORAGE, succeeded, wireOutput } from './support/mock-api.js';

type Sdk = typeof first;

const ENV_NAMES = [
  'IMS_OAUTH_S2S_CLIENT_ID',
  'IMS_OAUTH_S2S_CLIENT_SECRET',
  'IMS_OAUTH_S2S_SCOPES',
] as const;
const WRITE = `${STORAGE}/out/a.mov?sv=2021&sp=w&sig=WRITE_SIG`;
const READ = `${STORAGE}/out/a.mov?sv=2021&sp=r&sig=READ_SIG`;
const AZURE_KEY = Buffer.from('dual-copy-account-key').toString('base64');

let second: Sdk;
let api: MockApi;

beforeAll(async () => {
  vi.resetModules();
  second = (await import('../src/index.js')) as Sdk;
});

beforeEach(() => {
  api = new MockApi();
  api.ims();
  for (const name of ENV_NAMES) vi.stubEnv(name, undefined);
  first.resetDefaultClient();
  second.resetDefaultClient();
});

afterEach(async () => {
  first.resetDefaultClient();
  second.resetDefaultClient();
  vi.unstubAllEnvs();
  await api.close();
});

afterAll(() => {
  vi.resetModules();
});

/** A client config authenticating with a fixed token, so no IMS request is made. */
function tenant(clientId: string): Parameters<Sdk['configure']>[0] {
  return {
    clientId,
    tokenProvider: { getAccessToken: async () => `${clientId}-token` },
    logging: false,
  };
}

/** The x-api-key of every presets listing the API received, in order. */
function listingKeys(): string[] {
  return api.calls
    .filter((call) => call.origin === API && call.path === '/v1/presets')
    .map((call) => call.headers['x-api-key'] ?? '');
}

test('the second copy really is a separate copy of every module', () => {
  expect(second.AudioVideoError).not.toBe(first.AudioVideoError);
  expect(second.configure).not.toBe(first.configure);
});

test('configure() through either copy installs the default client the other copy calls, with no fallback to the environment', async () => {
  vi.stubEnv('IMS_OAUTH_S2S_CLIENT_ID', 'ENV_CLIENT');
  vi.stubEnv('IMS_OAUTH_S2S_CLIENT_SECRET', 'env-secret');
  api.reply('GET', '/v1/presets', 200, { items: [] });

  second.configure(tenant('TENANT_A'));
  await first.listPresets();
  first.configure(tenant('TENANT_B'));
  await second.listPresets();

  expect(listingKeys()).toEqual(['TENANT_A', 'TENANT_B']);
  expect(api.imsRequests()).toEqual([]);
});

test('resetDefaultClient() through either copy clears the default client for both', async () => {
  first.configure(tenant('TENANT_A'));
  second.resetDefaultClient();

  const error = await first.listPresets().catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(first.AudioVideoError);
  expect((error as first.AudioVideoError).code).toBe('invalid_argument');
  expect((error as first.AudioVideoError).message).toContain('No client is configured');
});

test('an error either copy throws is instanceof both copies of AudioVideoError, and of Error', async () => {
  const fromSecond = await second.status('').catch((reason: unknown) => reason);
  const fromFirst = await first.status('').catch((reason: unknown) => reason);

  for (const error of [fromSecond, fromFirst]) {
    expect(error instanceof first.AudioVideoError).toBe(true);
    expect(error instanceof second.AudioVideoError).toBe(true);
    expect(error instanceof Error).toBe(true);
  }
});

test('every exported class recognizes an instance the other copy made', () => {
  const instances = (sdk: Sdk): Array<[name: string, instance: unknown]> => [
    ['AudioVideoError', new sdk.AudioVideoError({ message: 'x', code: 'x' })],
    [
      'Asset',
      new sdk.Asset({ url: 'https://example.test/a.mov', meta: { jobId: 'j', perItem: [] } }),
    ],
    ['Preset', sdk.presets.prores],
    ['InMemoryPool', new sdk.InMemoryPool()],
    ['PassthroughStorageProvider', new sdk.PassthroughStorageProvider()],
    [
      'ClientCredentialsProvider',
      new sdk.ClientCredentialsProvider({ clientId: 'c', clientSecret: 's' }),
    ],
    ['AioFilesStorageProvider', new sdk.AioFilesStorageProvider({ namespace: 'ns', auth: 'auth' })],
    [
      'AzureBlobStorageProvider',
      new sdk.AzureBlobStorageProvider({
        container: 'c',
        accountName: 'dualcopy',
        accountKey: AZURE_KEY,
      }),
    ],
    [
      'S3StorageProvider',
      new sdk.S3StorageProvider({
        bucket: 'b',
        region: 'us-east-1',
        credentials: { accessKeyId: 'AKIADUALCOPY', secretAccessKey: 'secret' },
      }),
    ],
  ];
  const constructors = (sdk: Sdk): Record<string, unknown> =>
    sdk as unknown as Record<string, unknown>;

  for (const [made, other] of [
    [second, first],
    [first, second],
  ] as const) {
    for (const [name, instance] of instances(made)) {
      const ctor = constructors(other)[name] as abstract new (...args: never[]) => unknown;
      expect(instance instanceof ctor, name).toBe(true);
    }
  }
});

test('a preset one copy built renders through the other copy, resolving to its presetId', async () => {
  api.submit(['job-1']);
  api.status('job-1', () => succeeded('job-1', [wireOutput(0, 0, 1, 2, WRITE)]));
  second.configure(tenant('TENANT_A'));

  const asset = await first.render(
    {
      source: `${STORAGE}/capsule.mogrt`,
      presets: [first.presets.prores],
      outputs: [{ presetIndex: 0, destination: WRITE, readUrl: READ }],
    },
    { pollIntervalMs: 0 },
  );

  expect(api.submitted()[0]?.presets).toEqual([{ source: { presetId: 'ffs_video_api_prores' } }]);
  expect(asset instanceof first.Asset).toBe(true);
  expect(asset instanceof second.Asset).toBe(true);
});

test("a client one copy created serves the other copy's calls given as { client }", async () => {
  api.reply('GET', '/v1/presets', 200, { items: [] });
  const client = second.createClient(tenant('TENANT_C'));

  await first.listPresets({ client });

  expect(listingKeys()).toEqual(['TENANT_C']);
});
