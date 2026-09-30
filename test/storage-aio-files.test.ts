import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import type { Files, init as realInit } from '@adobe/aio-lib-files';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterAll, afterEach, beforeAll, beforeEach, expect, expectTypeOf, test, vi } from 'vitest';
import { AudioVideoError } from '../src/core/errors.js';
import { createClient } from '../src/dgr/client.js';
import {
  AioFilesStorageProvider,
  appBuilderStorage,
  type AioFilesClient,
  type AioFilesModule,
} from '../src/storage/aio-files.js';
import { loadPeer, type Peer } from '../src/storage/peer.js';
import { fakeStorage } from './support/mock-api.js';

vi.mock('../src/storage/peer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/storage/peer.js')>();
  return {
    ...actual,
    loadPeer: vi.fn(() => Promise.reject(new Error('loadPeer is not stubbed in this test'))),
  };
});

const BLOB = 'https://fav.blob.core.windows.net';
const AUTH = 'runtime-auth-uuid:RUNTIME_AUTH_SECRET_VALUE';
const ENV = ['__OW_NAMESPACE', '__OW_API_KEY', 'AIO_runtime_namespace', 'AIO_runtime_auth'];

interface PresignCall {
  key: string;
  options: { expiryInSeconds: number; permissions: string; urlType: string };
}

interface RecordedPut {
  path: string;
  headers: Record<string, string>;
  body: string;
}

let agent: MockAgent;
const original = getGlobalDispatcher();
let puts: RecordedPut[];
let dir: string;
let logo: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fav-aio-files-'));
  logo = join(dir, 'logo.png');
  writeFileSync(logo, 'png bytes on disk');
});

afterAll(() => {
  unlinkSync(logo);
  rmdirSync(dir);
});

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  puts = [];
  for (const name of ENV) vi.stubEnv(name, '');
});

afterEach(async () => {
  await agent.close();
  setGlobalDispatcher(original);
  vi.unstubAllEnvs();
  vi.mocked(loadPeer).mockReset();
  vi.mocked(loadPeer).mockImplementation(() =>
    Promise.reject(new Error('loadPeer is not stubbed in this test')),
  );
});

/** A fake `Files` client, typed from the SDK's own `generatePresignURL`, answering SAS-shaped URLs. */
function fakeFiles(): Pick<Files, 'generatePresignURL'> & { calls: PresignCall[] } {
  const calls: PresignCall[] = [];
  return {
    calls,
    async generatePresignURL(key, options) {
      calls.push({ key, options });
      const path = key
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/');
      return `${BLOB}/fav/${path}?sv=2025-01-05&sp=${options.permissions}&sig=SIG_${options.permissions}_${calls.length}`;
    },
  };
}

/** A fake `@adobe/aio-lib-files` module whose `init` records its config and returns `files`. */
function fakeModule(files: AioFilesClient): AioFilesModule & { configs: unknown[] } {
  const configs: unknown[] = [];
  return {
    configs,
    async init(config) {
      configs.push(config);
      return files;
    },
  };
}

/** Drains a MockAgent request body: a string, or chunks. */
async function readBody(body: unknown): Promise<string> {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The blob store answering every `PUT` with `status`, recording each. */
function blobStore(status = 201, headers: Record<string, string> = {}): void {
  agent
    .get(BLOB)
    .intercept({ path: (path) => path.startsWith('/fav/'), method: 'PUT' })
    .reply(
      status,
      async (opts) => {
        puts.push({
          path: opts.path,
          headers: opts.headers as Record<string, string>,
          body: await readBody(opts.body),
        });
        return '';
      },
      { headers },
    )
    .persist();
}

/** The `AudioVideoError` a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<AudioVideoError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AudioVideoError);
    return error as AudioVideoError;
  }
  throw new Error('expected a rejection');
}

/** Every message along an error's cause chain, and every printed form of the error itself. */
function everythingPrinted(error: AudioVideoError): string {
  const causes: string[] = [];
  for (let cause: unknown = error.cause; cause instanceof Error; cause = cause.cause) {
    causes.push(cause.message, String(cause.stack));
  }
  return [error.message, String(error), JSON.stringify(error), inspect(error), ...causes].join(
    '\n',
  );
}

const STAGED_KEY = /^firefly-audio-video\/staged\/[0-9a-f-]{36}$/;
const OUTPUT_KEY = /^firefly-audio-video\/outputs\/[0-9a-f-]{36}$/;

test('the provider fakes and options are typed from the real SDK', () => {
  expectTypeOf<Files>().toExtend<AioFilesClient>();
  expectTypeOf<{ init: typeof realInit }>().toExtend<AioFilesModule>();
});

// --- stageRead -------------------------------------------------------------------------

test('stageRead presigns for read-write, PUTs a BlockBlob, then returns a read presign of the same key', async () => {
  blobStore();
  const files = fakeFiles();
  const provider = new AioFilesStorageProvider({ files });

  const url = await provider.stageRead(Buffer.from('png bytes'), { contentType: 'image/png' });

  expect(files.calls).toHaveLength(2);
  const [upload, read] = files.calls;
  expect(upload?.key).toMatch(STAGED_KEY);
  expect(read?.key).toBe(upload?.key);
  expect(upload?.options).toEqual({
    expiryInSeconds: 3600,
    permissions: 'rw',
    urlType: 'external',
  });
  expect(read?.options).toEqual({ expiryInSeconds: 3600, permissions: 'r', urlType: 'external' });
  expect(url).toMatch(/sp=r&sig=SIG_r_2$/);
  expect(puts).toHaveLength(1);
  expect(puts[0]?.path).toMatch(/sp=rw&sig=SIG_rw_1$/);
  expect(puts[0]?.headers['x-ms-blob-type']).toBe('BlockBlob');
  expect(puts[0]?.headers['content-type']).toBe('image/png');
  expect(puts[0]?.body).toBe('png bytes');
});

test('a file is uploaded from disk under a key that keeps its name', async () => {
  blobStore();
  const files = fakeFiles();
  await new AioFilesStorageProvider({ files }).stageRead(logo);
  expect(files.calls[0]?.key).toMatch(/^firefly-audio-video\/staged\/[0-9a-f-]{36}\/logo\.png$/);
  expect(puts[0]?.body).toBe('png bytes on disk');
  expect(puts[0]?.headers['content-type']).toBeUndefined();
});

test('a Readable is read in full and uploaded in one PUT', async () => {
  blobStore();
  const files = fakeFiles();
  await new AioFilesStorageProvider({ files }).stageRead(
    Readable.from([Buffer.from('par'), Buffer.from('ts')]),
  );
  expect(puts).toHaveLength(1);
  expect(puts[0]?.body).toBe('parts');
});

test('key and expiresIn options name the object and its lifetime; prefix places every key', async () => {
  blobStore();
  const files = fakeFiles();
  await new AioFilesStorageProvider({ files }).stageRead(Buffer.from('x'), {
    key: 'brand/logo.png',
    expiresIn: 600,
  });
  await new AioFilesStorageProvider({ files, prefix: 'renders' }).stageRead(Buffer.from('x'));
  await new AioFilesStorageProvider({ files, prefix: '' }).allocateOutput();
  await new AioFilesStorageProvider({ files, expiresIn: 900 }).allocateOutput();
  expect(files.calls.map((call) => call.key)).toEqual([
    'firefly-audio-video/brand/logo.png',
    'firefly-audio-video/brand/logo.png',
    expect.stringMatching(/^renders\/staged\//),
    expect.stringMatching(/^renders\/staged\//),
    expect.stringMatching(/^outputs\//),
    expect.stringMatching(/^outputs\//),
    expect.stringMatching(OUTPUT_KEY),
    expect.stringMatching(OUTPUT_KEY),
  ]);
  expect(files.calls.map((call) => call.options.expiryInSeconds)).toEqual([
    600, 600, 3600, 3600, 86400, 86400, 900, 900,
  ]);
});

// --- allocateOutput ---------------------------------------------------------------------

test('allocateOutput presigns one key for writing and for reading, for 24 hours, and uploads nothing', async () => {
  const files = fakeFiles();
  const slot = await new AioFilesStorageProvider({ files }).allocateOutput();
  expect(files.calls.map((call) => call.options)).toEqual([
    { expiryInSeconds: 86400, permissions: 'w', urlType: 'external' },
    { expiryInSeconds: 86400, permissions: 'r', urlType: 'external' },
  ]);
  expect(files.calls[0]?.key).toMatch(OUTPUT_KEY);
  expect(files.calls[1]?.key).toBe(files.calls[0]?.key);
  expect(slot.writeUrl).toMatch(/sp=w&sig=SIG_w_1$/);
  expect(slot.readUrl).toMatch(/sp=r&sig=SIG_r_2$/);
  expect(puts).toEqual([]);
});

// --- what is refused ----------------------------------------------------------------------

test('an http(s) URL, a missing file or an invalid option rejects invalid_argument before any presign', async () => {
  const files = fakeFiles();
  const provider = new AioFilesStorageProvider({ files });
  const url = await rejection(provider.stageRead('https://example.com/a.png'));
  expect(url.message).toContain('is an http(s) URL DGR can read as it is');
  const missing = await rejection(provider.stageRead('./no-such-file.png'));
  expect(missing.code).toBe('invalid_argument');
  for (const expiresIn of [1, 86_401, 1.5, Number.NaN]) {
    const error = await rejection(provider.stageRead(Buffer.from('x'), { expiresIn }));
    expect(error.message).toBe(
      'AioFilesStorageProvider: expiresIn must be a whole number of seconds from 2 to 86400.',
    );
  }
  const key = await rejection(provider.allocateOutput({ key: '' }));
  expect(key.message).toContain('key must be a non-empty string');
  const type = await rejection(provider.stageRead(Buffer.from('x'), { contentType: '' }));
  expect(type.code).toBe('invalid_argument');
  expect(files.calls).toEqual([]);
});

test('invalid constructor options throw invalid_argument', () => {
  for (const options of [
    { namespace: 'ns' },
    { auth: AUTH },
    { namespace: ' ', auth: AUTH },
    { expiresIn: 0 },
    { prefix: 42 },
    { files: {} },
  ]) {
    expect(() => new AioFilesStorageProvider(options as never)).toThrow(AudioVideoError);
  }
});

// --- failures, and what they print ------------------------------------------------------

test('a refused PUT rejects storage_failed with its status and error code, never a SAS', async () => {
  blobStore(403, { 'x-ms-error-code': 'AuthenticationFailed' });
  const files = fakeFiles();
  const error = await rejection(new AioFilesStorageProvider({ files }).stageRead(Buffer.from('x')));
  expect(error.code).toBe('storage_failed');
  expect(error.message).toBe('Uploading the object failed with status 403 (AuthenticationFailed).');
  expect(files.calls).toHaveLength(1);
  expect(everythingPrinted(error)).not.toMatch(/SIG_/);
});

test('a PUT that fails in transit rejects storage_failed, and no SAS survives anywhere in the error or its causes', async () => {
  agent
    .get(BLOB)
    .intercept({ path: (path) => path.startsWith('/fav/'), method: 'PUT' })
    .replyWithError(new Error(`socket hang up during ${BLOB}/fav/x?sv=2025&sp=rw&sig=SIG_TRANSIT`));
  const error = await rejection(
    new AioFilesStorageProvider({ files: fakeFiles() }).stageRead(Buffer.from('x')),
  );
  expect(error.code).toBe('storage_failed');
  expect(error.message.startsWith('Uploading the object failed before a response arrived')).toBe(
    true,
  );
  expect(error.cause).toBeInstanceOf(Error);
  expect(everythingPrinted(error)).not.toMatch(/SIG_/);
});

test('a failing presign rejects storage_failed with its reason, redacted', async () => {
  const files: AioFilesClient = {
    generatePresignURL: () =>
      Promise.reject(new Error(`TVM said no for ${BLOB}/fav/k?sv=1&sig=SIG_PRESIGN_FAIL`)),
  };
  const error = await rejection(new AioFilesStorageProvider({ files }).allocateOutput());
  expect(error.code).toBe('storage_failed');
  expect(error.message).toContain('Presigning write access to the object failed: TVM said no for');
  expect(everythingPrinted(error)).not.toMatch(/SIG_/);

  const empty = await rejection(
    new AioFilesStorageProvider({ files: { generatePresignURL: async () => '' } }).allocateOutput(),
  );
  expect(empty.message).toBe('generatePresignURL() resolved without a URL.');
});

// --- init, credentials, and loading the SDK ---------------------------------------------

test('init runs once, with the credentials from the options, for every later call', async () => {
  blobStore();
  const files = fakeFiles();
  const module = fakeModule(files);
  const provider = new AioFilesStorageProvider({ namespace: 'ns-1', auth: AUTH, module });
  await provider.stageRead(Buffer.from('x'));
  await provider.allocateOutput();
  expect(module.configs).toEqual([{ ow: { namespace: 'ns-1', auth: AUTH } }]);
  expect(loadPeer).not.toHaveBeenCalled();
});

test("a CommonJS module's default export works as the module", async () => {
  const files = fakeFiles();
  const inner = fakeModule(files);
  const provider = new AioFilesStorageProvider({
    namespace: 'ns',
    auth: AUTH,
    module: { default: inner } as unknown as AioFilesModule,
  });
  await provider.allocateOutput();
  expect(inner.configs).toHaveLength(1);
});

test('credentials come from the action (__OW_*), else from the CLI (AIO_runtime_*), and options win', async () => {
  const cases: Array<[Record<string, string>, object | undefined, object]> = [
    [
      { __OW_NAMESPACE: 'action-ns', __OW_API_KEY: 'action-key' },
      undefined,
      { namespace: 'action-ns', auth: 'action-key' },
    ],
    [
      { AIO_runtime_namespace: 'cli-ns', AIO_runtime_auth: 'cli-key' },
      undefined,
      { namespace: 'cli-ns', auth: 'cli-key' },
    ],
    [
      {
        __OW_NAMESPACE: 'action-ns',
        __OW_API_KEY: 'action-key',
        AIO_runtime_namespace: 'cli-ns',
        AIO_runtime_auth: 'cli-key',
      },
      undefined,
      { namespace: 'action-ns', auth: 'action-key' },
    ],
    [
      { __OW_NAMESPACE: 'action-ns', __OW_API_KEY: 'action-key' },
      { namespace: 'opt-ns', auth: 'opt-key' },
      { namespace: 'opt-ns', auth: 'opt-key' },
    ],
  ];
  for (const [env, credentials, expected] of cases) {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const module = fakeModule(fakeFiles());
    await new AioFilesStorageProvider({ ...credentials, module }).allocateOutput();
    expect(module.configs).toEqual([{ ow: expected }]);
    for (const name of ENV) vi.stubEnv(name, '');
  }
});

test('no credentials anywhere rejects invalid_argument naming every way to supply them, before loading the SDK', async () => {
  const module = fakeModule(fakeFiles());
  const error = await rejection(new AioFilesStorageProvider({ module }).allocateOutput());
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('pass { namespace, auth }');
  expect(error.message).toContain('__OW_NAMESPACE and __OW_API_KEY');
  expect(error.message).toContain('AIO_runtime_namespace and AIO_runtime_auth');
  expect(module.configs).toEqual([]);
  expect(loadPeer).not.toHaveBeenCalled();
});

test('a failed init rejects storage_failed with the auth key scrubbed, and the next call tries again', async () => {
  const files = fakeFiles();
  let attempts = 0;
  const module: AioFilesModule = {
    async init() {
      attempts += 1;
      if (attempts === 1) throw new Error(`TVM rejected auth ${AUTH} for namespace ns`);
      return files;
    },
  };
  const provider = new AioFilesStorageProvider({ namespace: 'ns', auth: AUTH, module });
  const error = await rejection(provider.allocateOutput());
  expect(error.code).toBe('storage_failed');
  expect(error.message).toContain('Initializing @adobe/aio-lib-files failed: TVM rejected auth');
  expect(everythingPrinted(error)).not.toContain('RUNTIME_AUTH_SECRET_VALUE');
  await expect(provider.allocateOutput()).resolves.toHaveProperty('writeUrl');
  expect(attempts).toBe(2);
});

test('an init that resolves without a Files client rejects storage_failed', async () => {
  const module = { init: async () => ({}) } as unknown as AioFilesModule;
  const error = await rejection(
    new AioFilesStorageProvider({ namespace: 'ns', auth: AUTH, module }).allocateOutput(),
  );
  expect(error.message).toBe('@adobe/aio-lib-files init() resolved without a Files client.');
});

test('without module or files, the SDK is loaded by name on first use — never at construction', async () => {
  const files = fakeFiles();
  const module = fakeModule(files);
  vi.mocked(loadPeer).mockResolvedValue(module);
  const provider = new AioFilesStorageProvider({ namespace: 'ns', auth: AUTH });
  expect(loadPeer).not.toHaveBeenCalled();
  await provider.allocateOutput();
  await provider.allocateOutput();
  expect(loadPeer).toHaveBeenCalledTimes(1);
  expect(vi.mocked(loadPeer).mock.calls[0]?.[0]).toMatchObject({
    specifier: '@adobe/aio-lib-files',
    install: 'npm install @adobe/aio-lib-files',
  });
});

test('a missing @adobe/aio-lib-files rejects missing_peer_dependency naming the install command', async () => {
  const actual =
    await vi.importActual<typeof import('../src/storage/peer.js')>('../src/storage/peer.js');
  vi.mocked(loadPeer).mockImplementation((peer: Peer) =>
    actual.loadPeer(peer, () =>
      Promise.reject(
        Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' }),
      ),
    ),
  );
  const error = await rejection(
    new AioFilesStorageProvider({ namespace: 'ns', auth: AUTH }).stageRead(Buffer.from('x')),
  );
  expect(error.code).toBe('missing_peer_dependency');
  expect(error.message).toContain('`npm install @adobe/aio-lib-files`');
  expect(error.message).toContain('pass the module as the module option instead');
});

test('the auth key never appears in how the provider prints', () => {
  const provider = new AioFilesStorageProvider({ namespace: 'ns', auth: AUTH });
  expect(`${inspect(provider, { depth: 5 })}\n${JSON.stringify(provider)}`).not.toContain(
    'RUNTIME_AUTH_SECRET_VALUE',
  );
});

// --- auto-selection ------------------------------------------------------------------------

test('appBuilderStorage picks Files when __OW_NAMESPACE or AIO_runtime_namespace is set, and nothing otherwise', () => {
  expect(appBuilderStorage({ __OW_NAMESPACE: 'ns' })).toBeInstanceOf(AioFilesStorageProvider);
  expect(appBuilderStorage({ AIO_runtime_namespace: 'ns' })).toBeInstanceOf(
    AioFilesStorageProvider,
  );
  expect(appBuilderStorage({})).toBeUndefined();
  expect(appBuilderStorage({ __OW_NAMESPACE: ' ', AIO_runtime_namespace: '' })).toBeUndefined();
  expect(appBuilderStorage({ __OW_API_KEY: 'k', AIO_runtime_auth: 'k' })).toBeUndefined();
});

test('a client with no storage stages through Files when the App Builder environment is present', async () => {
  blobStore();
  vi.stubEnv('AIO_runtime_namespace', 'cli-ns');
  vi.stubEnv('AIO_runtime_auth', 'cli-key');
  const files = fakeFiles();
  const module = fakeModule(files);
  vi.mocked(loadPeer).mockResolvedValue(module);

  const client = createClient({ clientId: 'id', clientSecret: 'secret', logging: false });
  const url = await client.stage(Buffer.from('logo'));

  expect(url).toMatch(
    /^https:\/\/fav\.blob\.core\.windows\.net\/fav\/firefly-audio-video\/staged\//,
  );
  expect(module.configs).toEqual([{ ow: { namespace: 'cli-ns', auth: 'cli-key' } }]);
  expect(puts).toHaveLength(1);
});

test('the App Builder environment alone selects Files: missing credentials then surface when it is used', async () => {
  vi.stubEnv('__OW_NAMESPACE', 'action-ns');
  const client = createClient({ clientId: 'id', clientSecret: 'secret', logging: false });
  const error = await rejection(client.stage(Buffer.from('logo')));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('AioFilesStorageProvider needs Runtime credentials');
});

test('outside App Builder a client with no storage has none', async () => {
  const client = createClient({ clientId: 'id', clientSecret: 'secret', logging: false });
  const error = await rejection(client.stage(Buffer.from('logo')));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('no storage is configured');
  expect(loadPeer).not.toHaveBeenCalled();
});

test('an explicit storage wins over the App Builder environment', async () => {
  vi.stubEnv('__OW_NAMESPACE', 'action-ns');
  vi.stubEnv('__OW_API_KEY', 'action-key');
  const storage = fakeStorage();
  const client = createClient({ clientId: 'id', clientSecret: 'secret', logging: false, storage });
  await expect(client.stage(Buffer.from('logo'))).resolves.toMatch(/STAGE_SIG_1$/);
  expect(storage.staged).toHaveLength(1);
  expect(loadPeer).not.toHaveBeenCalled();
});
