/**
 * Two copies of the package in one process — what an application gets when it
 * imports the ESM build while a CommonJS dependency requires the CommonJS
 * build — share one default client and one identity for every exported
 * class. The second copy here is the source loaded again under a fresh module
 * registry, so every module in it, and every class, is a separate instance.
 * A copy of another version — a dependency that installed a different release
 * — shares neither; it is loaded the same way, with its version module
 * reporting that other version.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
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

/** One instance of every class the package exports, made by `sdk`. */
function instances(sdk: Sdk): Array<[name: string, instance: unknown]> {
  return [
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
}

/** The class `sdk` exports as `name`. */
function exported(sdk: Sdk, name: string): abstract new (...args: never[]) => unknown {
  return (sdk as unknown as Record<string, abstract new (...args: never[]) => unknown>)[name]!;
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
  for (const [made, other] of [
    [second, first],
    [first, second],
  ] as const) {
    for (const [name, instance] of instances(made)) {
      expect(instance instanceof exported(other, name), name).toBe(true);
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

describe('a copy of another version', () => {
  const OTHER_VERSION = '0.0.0-other';
  let other: Sdk;

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('../src/version.js', () => ({ VERSION: OTHER_VERSION }));
    other = (await import('../src/index.js')) as Sdk;
    vi.doUnmock('../src/version.js');
  });

  beforeEach(() => other.resetDefaultClient());

  afterEach(() => other.resetDefaultClient());

  test('reports that version, and is a separate copy of every module', () => {
    expect(other.VERSION).toBe(OTHER_VERSION);
    expect(first.VERSION).not.toBe(OTHER_VERSION);
    expect(other.configure).not.toBe(first.configure);
  });

  test('configure() through either version installs a default client only that version calls, and the other version creates its own from the environment', async () => {
    vi.stubEnv('IMS_OAUTH_S2S_CLIENT_ID', 'ENV_CLIENT');
    vi.stubEnv('IMS_OAUTH_S2S_CLIENT_SECRET', 'env-secret');
    api.reply('GET', '/v1/presets', 200, { items: [] });

    for (const [through, calledFrom, clientId] of [
      [first, other, 'TENANT_A'],
      [other, first, 'TENANT_B'],
    ] as const) {
      through.configure(tenant(clientId));
      await calledFrom.listPresets();
      await through.listPresets();
      through.resetDefaultClient();
      calledFrom.resetDefaultClient();
    }

    expect(listingKeys()).toEqual(['ENV_CLIENT', 'TENANT_A', 'ENV_CLIENT', 'TENANT_B']);
  });

  test("resetDefaultClient() through either version leaves the other version's default client in place", async () => {
    api.reply('GET', '/v1/presets', 200, { items: [] });

    for (const [configured, reset, clientId] of [
      [first, other, 'TENANT_A'],
      [other, first, 'TENANT_B'],
    ] as const) {
      configured.configure(tenant(clientId));
      reset.resetDefaultClient();
      await configured.listPresets();
      configured.resetDefaultClient();
    }

    expect(listingKeys()).toEqual(['TENANT_A', 'TENANT_B']);
  });

  test("a client one version created is refused by the other version's calls given as { client }", async () => {
    api.reply('GET', '/v1/presets', 200, { items: [] });

    for (const [made, calledFrom] of [
      [other, first],
      [first, other],
    ] as const) {
      const client = made.createClient(tenant('TENANT_C'));
      const error = await calledFrom.listPresets({ client }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(calledFrom.AudioVideoError);
      expect((error as first.AudioVideoError).code).toBe('invalid_argument');
      expect((error as first.AudioVideoError).message).toContain('created by createClient()');
    }

    expect(listingKeys()).toEqual([]);
  });

  test('no exported class recognizes an instance the other version made, while its own copy does', () => {
    for (const [made, calledFrom] of [
      [other, first],
      [first, other],
    ] as const) {
      for (const [name, instance] of instances(made)) {
        expect(instance instanceof exported(made, name), `${name}, its own copy`).toBe(true);
        expect(instance instanceof exported(calledFrom, name), `${name}, the other version`).toBe(
          false,
        );
      }
    }
  });
});
