import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { Asset } from '../src/core/asset.js';
import { AudioVideoError } from '../src/core/errors.js';
import { createClient, type ClientConfig } from '../src/dgr/client.js';
import {
  cancel,
  configure,
  describe as describeTemplate,
  listPresets,
  render,
  resetDefaultClient,
  stage,
  status,
} from '../src/dgr/default-client.js';
import type { RenderRequest, RenderRequestOutput } from '../src/dgr/schemas.js';
import {
  API,
  IMS,
  MockApi,
  STORAGE,
  fakeStorage,
  running,
  succeeded,
  until,
  wireOutput,
} from './support/mock-api.js';

const CAPSULE = `${STORAGE}/capsule.mogrt?sv=2021&sp=r&sig=CAPSULE_SIG`;
const WRITE = `${STORAGE}/out/a.mov?sv=2021&sp=w&sig=WRITE_SIG_A`;
const READ = `${STORAGE}/out/a.mov?sv=2021&sp=r&sig=READ_SIG_A`;
const ENV_NAMES = [
  'IMS_OAUTH_S2S_CLIENT_ID',
  'IMS_OAUTH_S2S_CLIENT_SECRET',
  'IMS_OAUTH_S2S_SCOPES',
];

let api: MockApi;
const unhandledRejections: unknown[] = [];
const onUnhandledRejection = (reason: unknown): void => void unhandledRejections.push(reason);

beforeAll(() => {
  process.on('unhandledRejection', onUnhandledRejection);
});

afterAll(() => {
  process.off('unhandledRejection', onUnhandledRejection);
});

beforeEach(() => {
  api = new MockApi();
  api.ims();
  for (const name of ENV_NAMES) vi.stubEnv(name, undefined);
  resetDefaultClient();
});

afterEach(async () => {
  resetDefaultClient();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await api.close();
  expect(unhandledRejections.splice(0)).toEqual([]);
});

function config(clientId: string, extra: Partial<ClientConfig> = {}): ClientConfig {
  return { clientId, clientSecret: `${clientId}-secret`, logging: false, ...extra };
}

function singleSpec(): Omit<RenderRequest, 'outputs'> & { outputs: [RenderRequestOutput] } {
  return {
    source: CAPSULE,
    presets: ['h264Land1080pHq'],
    outputs: [{ presetIndex: 0, destination: WRITE, readUrl: READ }],
  };
}

async function rejection(promise: PromiseLike<unknown>): Promise<AudioVideoError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AudioVideoError);
    return error as AudioVideoError;
  }
  throw new Error('expected a rejection');
}

/** The x-api-key of every API request matching `method` and `prefix`, in order. */
function apiKeys(method: string, prefix: string): string[] {
  return api.calls
    .filter((call) => call.origin === API && call.method === method && call.path.startsWith(prefix))
    .map((call) => call.headers['x-api-key'] ?? '');
}

test('with neither configure() nor the environment, the first call rejects invalid_argument naming both ways to configure', async () => {
  expect(process.env.IMS_OAUTH_S2S_CLIENT_ID).toBeUndefined();
  const errors = [
    await rejection(status('job-1')),
    await rejection(render(singleSpec())),
    await rejection(render(CAPSULE).prores),
    await rejection(describeTemplate(CAPSULE)),
  ];
  for (const error of errors) {
    expect(error.code).toBe('invalid_argument');
    expect(error.message).toContain('configure(');
    expect(error.message).toContain('IMS_OAUTH_S2S_CLIENT_ID');
    expect(error.message).toContain('IMS_OAUTH_S2S_CLIENT_SECRET');
  }
  expect(api.calls).toEqual([]);
});

test('an environment naming only the client ID still rejects, naming the missing variable', async () => {
  vi.stubEnv('IMS_OAUTH_S2S_CLIENT_ID', 'env-client');
  const error = await rejection(status('job-1'));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('Not set: IMS_OAUTH_S2S_CLIENT_SECRET.');
});

test('the environment configures the default client on first use, normalizing both scope forms to one comma-joined string', async () => {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  api.status('job-1', () => running('job-1'));
  vi.stubEnv('IMS_OAUTH_S2S_CLIENT_ID', 'env-client');
  vi.stubEnv('IMS_OAUTH_S2S_CLIENT_SECRET', 'env-secret');

  vi.stubEnv('IMS_OAUTH_S2S_SCOPES', '["openid","AdobeID","firefly_api","ff_apis"]');
  await status('job-1');
  resetDefaultClient();
  vi.stubEnv('IMS_OAUTH_S2S_SCOPES', 'openid, AdobeID ,firefly_api');
  await status('job-1');

  expect(api.imsRequests().map((mint) => mint.get('scope'))).toEqual([
    'openid,AdobeID,firefly_api,ff_apis',
    'openid,AdobeID,firefly_api',
  ]);
  expect(api.imsRequests().map((mint) => mint.get('client_id'))).toEqual([
    'env-client',
    'env-client',
  ]);
  expect(apiKeys('GET', '/v1/status/')).toEqual(['env-client', 'env-client']);
  // The environment's client logs as the default does: one NDJSON line per call, on stdout.
  const records = lines.map((line) => JSON.parse(line) as { msg: string });
  expect(records.map((record) => record.msg)).toEqual(['status completed', 'status completed']);
});

test('an environment scope that is neither a list nor a JSON array rejects invalid_argument naming the variable', async () => {
  vi.stubEnv('IMS_OAUTH_S2S_CLIENT_ID', 'env-client');
  vi.stubEnv('IMS_OAUTH_S2S_CLIENT_SECRET', 'env-secret');
  vi.stubEnv('IMS_OAUTH_S2S_SCOPES', '["openid", 42]');
  const error = await rejection(status('job-1'));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('IMS_OAUTH_S2S_SCOPES');
});

test('configure() is last-wins, and a job already running keeps the client it started on', async () => {
  let open = false;
  api.submit(['job-a', 'job-b']);
  api.status('job-a', () =>
    open ? succeeded('job-a', [wireOutput(0, 0, 1, 2, WRITE)]) : running('job-a'),
  );
  api.status('job-b', () => succeeded('job-b', [wireOutput(0, 0, 1, 2, WRITE)]));

  configure(config('first'));
  const first = render(singleSpec(), { pollIntervalMs: 1 });
  await until(() => first.jobId === 'job-a');

  configure(config('second'));
  const second = await render(singleSpec(), { pollIntervalMs: 0 });
  expect(second).toBeInstanceOf(Asset);

  open = true;
  await first;

  expect(apiKeys('POST', '/v1/templates/render')).toEqual(['first', 'second']);
  const jobAPolls = apiKeys('GET', '/v1/status/job-a');
  expect(jobAPolls.length).toBeGreaterThan(1);
  expect(new Set(jobAPolls)).toEqual(new Set(['first']));
  expect(apiKeys('GET', '/v1/status/job-b')).toEqual(['second']);
});

test('configure() with an invalid config throws and keeps the previous default client', async () => {
  api.status('job-1', () => running('job-1'));
  configure(config('kept'));
  expect(() => configure({ clientId: 'broken' })).toThrow(AudioVideoError);
  await status('job-1');
  expect(apiKeys('GET', '/v1/status/')).toEqual(['kept']);
});

test('a { client } option runs every top-level call on that client and never creates the default', async () => {
  const storage = fakeStorage();
  const tenant = createClient(config('tenant', { storage }));
  api.submit(['job-1', 'job-2']);
  api.status('job-1', () => succeeded('job-1', [wireOutput(0, 0, 1, 2, WRITE)]));
  api.status('job-2', () => succeeded('job-2', [wireOutput(0, 0, 1, 2)]));
  api.submit(['d-1'], { path: '/v1/templates/describe' });
  api.status('d-1', () => ({ jobId: 'd-1', status: 'succeeded', output: { elements: [] } }));
  api.cancel('job-1');
  api.reply('GET', '/v1/presets', 200, { items: [] });

  await render(singleSpec(), { client: tenant, pollIntervalMs: 0 });
  await render(CAPSULE, { client: tenant, pollIntervalMs: 0 }).h264Land1080pHq;
  await describeTemplate(CAPSULE, { client: tenant, pollIntervalMs: 0 });
  await status('job-1', { client: tenant });
  await cancel('job-1', { client: tenant });
  await listPresets({ client: tenant });
  await stage(Buffer.from('x'), { client: tenant });

  expect(
    new Set(api.calls.filter((call) => call.origin === API).map((c) => c.headers['x-api-key'])),
  ).toEqual(new Set(['tenant']));
  // No default was ever created: with no configuration, the next plain call still has none.
  const error = await rejection(status('job-1'));
  expect(error.code).toBe('invalid_argument');
  expect(api.calls.filter((call) => call.origin === IMS)).toHaveLength(1);
});

test('a { client } option leaves a configured default untouched', async () => {
  api.status('job-1', () => running('job-1'));
  configure(config('default'));
  const tenant = createClient(config('tenant'));

  await status('job-1', { client: tenant });
  await status('job-1');

  expect(apiKeys('GET', '/v1/status/')).toEqual(['tenant', 'default']);
});

test('resetDefaultClient() drops the default: the next call reads the environment again', async () => {
  api.status('job-1', () => running('job-1'));
  configure(config('configured'));
  await status('job-1');

  resetDefaultClient();
  const error = await rejection(status('job-1'));
  expect(error.code).toBe('invalid_argument');

  vi.stubEnv('IMS_OAUTH_S2S_CLIENT_ID', 'env-client');
  vi.stubEnv('IMS_OAUTH_S2S_CLIENT_SECRET', 'env-secret');
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await status('job-1');
  expect(apiKeys('GET', '/v1/status/')).toEqual(['configured', 'env-client']);
});

test('a fluent render on the default client resolves its client when it starts, not when it is built', async () => {
  const storage = fakeStorage();
  api.submit(['job-1']);
  api.status('job-1', () => succeeded('job-1', [wireOutput(0, 0, 1, 2)]));

  const builder = render(CAPSULE, { pollIntervalMs: 0 }).h264Land1080pHq;
  configure(config('late', { storage }));
  const asset = await builder;

  expect(asset.url).toBe(storage.allocations[0]?.readUrl);
  expect(apiKeys('POST', '/v1/templates/render')).toEqual(['late']);
});

test('the top-level functions reach the default client', async () => {
  const storage = fakeStorage();
  configure(config('default', { storage }));
  api.status('job-1', () => ({ jobId: 'job-1', status: 'running' }));
  api.cancel('job-1');
  api.reply('GET', '/v1/presets', 200, { items: [{ presetId: 'ffs_video_api_prores' }] });
  api.submit(['d-1'], { path: '/v1/templates/describe' });
  api.status('d-1', () => ({ jobId: 'd-1', status: 'succeeded', output: { fonts: [] } }));

  await expect(status('job-1')).resolves.toEqual({ jobId: 'job-1', status: 'running' });
  await expect(cancel('job-1')).resolves.toEqual({ jobId: 'job-1', status: 'canceling' });
  await expect(listPresets()).resolves.toEqual([{ presetId: 'ffs_video_api_prores' }]);
  await expect(stage(Buffer.from('x'))).resolves.toBe(
    `${STORAGE}/staged/1.epr?sv=2021&sp=r&sig=STAGE_SIG_1`,
  );
  await expect(describeTemplate({ source: CAPSULE }, { pollIntervalMs: 0 })).resolves.toEqual({
    controls: [],
    fonts: [],
  });
  expect(
    new Set(api.calls.filter((call) => call.origin === API).map((c) => c.headers['x-api-key'])),
  ).toEqual(new Set(['default']));
});
