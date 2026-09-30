import { Console } from 'node:console';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { inspect } from 'node:util';
import * as azureSdk from '@azure/storage-blob';
import type {
  BlobServiceClient,
  BlobUploadCommonResponse,
  BlockBlobClient,
  ContainerClient,
} from '@azure/storage-blob';
import { afterAll, afterEach, beforeAll, beforeEach, expect, expectTypeOf, test, vi } from 'vitest';
import { AudioVideoError } from '../src/core/errors.js';
import { createClient } from '../src/dgr/client.js';
import {
  AzureBlobStorageProvider,
  type AzureBlobModule,
  type AzureBlobServiceClient,
  type AzureBlockBlobClient,
  type AzureContainerClient,
} from '../src/storage/azure.js';
import { loadPeer, type Peer } from '../src/storage/peer.js';

vi.mock('../src/storage/peer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/storage/peer.js')>();
  return {
    ...actual,
    loadPeer: vi.fn(() => Promise.reject(new Error('loadPeer is not stubbed in this test'))),
  };
});

const ACCOUNT = 'favacct';
const CONTAINER = 'renders';
const ACCOUNT_KEY = Buffer.from('FAKE_AZURE_ACCOUNT_KEY_FOR_TESTS_ONLY_0123456789').toString(
  'base64',
);
const CONNECTION_STRING =
  `DefaultEndpointsProtocol=https;AccountName=${ACCOUNT};AccountKey=${ACCOUNT_KEY};` +
  'EndpointSuffix=core.windows.net';
const SAS_CONNECTION_STRING =
  `BlobEndpoint=https://${ACCOUNT}.blob.core.windows.net/;SharedAccessSignature=sv=2020-08-04` +
  '&ss=b&srt=sco&sp=rwdlacx&se=2030-01-01T00:00:00Z&sig=CONNECTION_STRING_SAS_SIG';
const BLOB_BASE = `https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}`;
const NOW = new Date('2026-09-29T12:00:00.000Z');
const UPLOADED = {} as BlobUploadCommonResponse;

let dir: string;
let logo: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fav-azure-'));
  logo = join(dir, 'logo.png');
  writeFileSync(logo, 'png bytes on disk');
});

afterAll(() => {
  unlinkSync(logo);
  rmdirSync(dir);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(loadPeer).mockReset();
  vi.mocked(loadPeer).mockImplementation(() =>
    Promise.reject(new Error('loadPeer is not stubbed in this test')),
  );
});

interface UploadCall {
  blob: string;
  method: 'uploadData' | 'uploadFile' | 'uploadStream';
  data: unknown;
  options: unknown;
}

interface SasCall {
  blob: string;
  permissions: string;
  expiresOn: Date | undefined;
  protocol: string | undefined;
}

/**
 * A fake container whose block blobs record every upload and SAS, with the
 * SDK's own `BlockBlobClient` method signatures, answering SAS-shaped URLs.
 */
function fakeContainer(base = BLOB_BASE) {
  const uploads: UploadCall[] = [];
  const sas: SasCall[] = [];
  const container: AzureContainerClient = {
    getBlockBlobClient(name) {
      const url = `${base}/${name.split('/').map(encodeURIComponent).join('/')}`;
      const blob: Pick<
        BlockBlobClient,
        'url' | 'uploadData' | 'uploadFile' | 'uploadStream' | 'generateSasUrl'
      > = {
        url,
        async uploadData(data, options) {
          uploads.push({ blob: name, method: 'uploadData', data, options });
          return UPLOADED;
        },
        async uploadFile(filePath, options) {
          uploads.push({ blob: name, method: 'uploadFile', data: filePath, options });
          return UPLOADED;
        },
        async uploadStream(stream, bufferSize, maxConcurrency, options) {
          expect([bufferSize, maxConcurrency]).toEqual([undefined, undefined]);
          uploads.push({ blob: name, method: 'uploadStream', data: stream, options });
          return UPLOADED;
        },
        async generateSasUrl(options) {
          const permissions = String(options.permissions);
          sas.push({
            blob: name,
            permissions,
            expiresOn: options.expiresOn,
            protocol: options.protocol,
          });
          return `${url}?sv=2026-10-06&se=${options.expiresOn?.toISOString()}&sr=b&sp=${permissions}&sig=SIG_${permissions}_${sas.length}`;
        },
      };
      return blob;
    },
  };
  return { container, uploads, sas };
}

/** A fake service client handing out `container`, recording which container was opened. */
function fakeService(container: AzureContainerClient) {
  const opened: string[] = [];
  const service: AzureBlobServiceClient = {
    getContainerClient(name) {
      opened.push(name);
      return container;
    },
  };
  return { service, opened };
}

/** The real `BlobSASPermissions`, with a `fromConnectionString` that records every connection string and answers `service`. */
function recordingModule(service: AzureBlobServiceClient) {
  const built: string[] = [];
  const module: AzureBlobModule = {
    BlobServiceClient: {
      fromConnectionString(connectionString) {
        built.push(connectionString);
        return service;
      },
    },
    BlobSASPermissions: azureSdk.BlobSASPermissions,
  };
  return { module, built };
}

/** A provider over a fake container, through an injected client and the real `BlobSASPermissions`. */
function fakeProvider(options: { prefix?: string; expiresIn?: number; base?: string } = {}) {
  const store = fakeContainer(options.base);
  const { service, opened } = fakeService(store.container);
  const provider = new AzureBlobStorageProvider({
    container: CONTAINER,
    client: service,
    module: azureSdk,
    ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
    ...(options.expiresIn !== undefined ? { expiresIn: options.expiresIn } : {}),
  });
  return { provider, opened, ...store };
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

/** The `AudioVideoError` a function throws. */
function thrown(fn: () => unknown): AudioVideoError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AudioVideoError);
    return error as AudioVideoError;
  }
  throw new Error('expected a throw');
}

/** Every printed form of an error, and every message along its cause chain. */
function everythingPrinted(error: AudioVideoError): string {
  const causes: string[] = [];
  for (let cause: unknown = error.cause; cause instanceof Error; cause = cause.cause) {
    causes.push(cause.message, String(cause.stack));
  }
  return [error.message, String(error), JSON.stringify(error), inspect(error), ...causes].join(
    '\n',
  );
}

/** Every common printed form of a value: `inspect`, `String`, `JSON.stringify`, a spread copy, and what `console.log` writes. */
function printedForms(value: object): string {
  const written: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      written.push(String(chunk));
      done();
    },
  });
  new Console({ stdout: sink, stderr: sink }).log(value);
  return [
    inspect(value, { depth: 10, showHidden: true }),
    String(value),
    JSON.stringify(value),
    inspect({ ...value }, { depth: 10 }),
    ...written,
  ].join('\n');
}

const STAGED_KEY = /^firefly-audio-video\/staged\/[0-9a-f-]{36}$/;
const OUTPUT_KEY = /^firefly-audio-video\/outputs\/[0-9a-f-]{36}$/;
const inSeconds = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

test('the provider option types are satisfied by the real SDK', () => {
  expectTypeOf<typeof azureSdk>().toExtend<AzureBlobModule>();
  expectTypeOf<BlobServiceClient>().toExtend<AzureBlobServiceClient>();
  expectTypeOf<ContainerClient>().toExtend<AzureContainerClient>();
  expectTypeOf<BlockBlobClient>().toExtend<AzureBlockBlobClient>();
});

// --- stageRead -------------------------------------------------------------------------

test('stageRead uploads a Buffer as a block blob, then returns a read-only HTTPS SAS for the same blob', async () => {
  const { provider, uploads, sas, opened } = fakeProvider();
  const bytes = Buffer.from('png bytes');

  const url = await provider.stageRead(bytes, { contentType: 'image/png' });

  expect(opened).toEqual([CONTAINER]);
  expect(uploads).toHaveLength(1);
  expect(uploads[0]?.method).toBe('uploadData');
  expect(uploads[0]?.data).toBe(bytes);
  expect(uploads[0]?.options).toEqual({ blobHTTPHeaders: { blobContentType: 'image/png' } });
  expect(uploads[0]?.blob).toMatch(STAGED_KEY);
  expect(sas).toEqual([
    { blob: uploads[0]?.blob, permissions: 'r', expiresOn: inSeconds(3600), protocol: 'https' },
  ]);
  expect(url.startsWith(`${BLOB_BASE}/firefly-audio-video/staged/`)).toBe(true);
  expect(url).toMatch(/sp=r&sig=SIG_r_1$/);
});

test('a file uploads from disk by its path, under a key that keeps its name', async () => {
  const { provider, uploads } = fakeProvider();
  await provider.stageRead(logo);
  expect(uploads).toEqual([
    {
      blob: expect.stringMatching(/^firefly-audio-video\/staged\/[0-9a-f-]{36}\/logo\.png$/),
      method: 'uploadFile',
      data: logo,
      options: {},
    },
  ]);
});

test('a Readable uploads in blocks as the stream it is, never read into memory first', async () => {
  const { provider, uploads } = fakeProvider();
  const stream = Readable.from([Buffer.from('par'), Buffer.from('ts')]);
  await provider.stageRead(stream);
  expect(uploads).toHaveLength(1);
  expect(uploads[0]?.method).toBe('uploadStream');
  expect(uploads[0]?.data).toBe(stream);
  expect(stream.readableEnded).toBe(false);
});

test('stageRead hands its signal to every kind of upload as the abortSignal', async () => {
  const { provider, uploads } = fakeProvider();
  const controller = new AbortController();
  const { signal } = controller;
  await provider.stageRead(Buffer.from('x'), { signal, contentType: 'image/png' });
  await provider.stageRead(logo, { signal });
  await provider.stageRead(Readable.from([Buffer.from('x')]), { signal });
  expect(uploads.map(({ method }) => method)).toEqual(['uploadData', 'uploadFile', 'uploadStream']);
  expect(uploads[0]?.options).toEqual({
    blobHTTPHeaders: { blobContentType: 'image/png' },
    abortSignal: signal,
  });
  for (const upload of uploads) {
    expect((upload.options as { abortSignal?: unknown }).abortSignal).toBe(signal);
  }
});

// --- allocateOutput ---------------------------------------------------------------------

test('allocateOutput signs a create-and-write SAS and a read SAS for one blob, for 24 hours, and uploads nothing', async () => {
  const { provider, uploads, sas } = fakeProvider();
  const slot = await provider.allocateOutput();
  expect(sas.map(({ permissions }) => permissions)).toEqual(['cw', 'r']);
  expect(sas[0]?.blob).toMatch(OUTPUT_KEY);
  expect(sas[1]?.blob).toBe(sas[0]?.blob);
  expect(sas.map(({ expiresOn }) => expiresOn)).toEqual([inSeconds(86400), inSeconds(86400)]);
  expect(sas.map(({ protocol }) => protocol)).toEqual(['https', 'https']);
  expect(slot.writeUrl).toMatch(/sp=cw&sig=SIG_cw_1$/);
  expect(slot.readUrl).toMatch(/sp=r&sig=SIG_r_2$/);
  expect(uploads).toEqual([]);
});

test('key, expiresIn and prefix name the blob and its lifetime', async () => {
  const first = fakeProvider();
  await first.provider.stageRead(Buffer.from('x'), { key: 'brand/logo.png', expiresIn: 600 });
  const second = fakeProvider({ prefix: 'tenant-a', expiresIn: 7200 });
  await second.provider.allocateOutput();
  await second.provider.allocateOutput({ key: 'renders/out.mov', expiresIn: 60 });
  expect(first.sas).toEqual([
    {
      blob: 'firefly-audio-video/brand/logo.png',
      permissions: 'r',
      expiresOn: inSeconds(600),
      protocol: 'https',
    },
  ]);
  expect(second.sas.map(({ blob }) => blob)).toEqual([
    expect.stringMatching(/^tenant-a\/outputs\/[0-9a-f-]{36}$/),
    expect.stringMatching(/^tenant-a\/outputs\/[0-9a-f-]{36}$/),
    'tenant-a/renders/out.mov',
    'tenant-a/renders/out.mov',
  ]);
  expect(second.sas.map(({ expiresOn }) => expiresOn)).toEqual([
    inSeconds(7200),
    inSeconds(7200),
    inSeconds(60),
    inSeconds(60),
  ]);
});

test('on an HTTP endpoint, as Azurite serves, the SAS is not restricted to HTTPS', async () => {
  const { provider, sas } = fakeProvider({ base: 'http://127.0.0.1:10000/devstoreaccount1/r' });
  await provider.allocateOutput();
  expect(sas.map(({ protocol }) => protocol)).toEqual([undefined, undefined]);
});

// --- the real SDK, offline ----------------------------------------------------------------

test('with the real SDK, offline: an account key signs a write SAS and a read SAS for one blob, HTTPS only', async () => {
  const provider = new AzureBlobStorageProvider({
    container: CONTAINER,
    accountName: ACCOUNT,
    accountKey: ACCOUNT_KEY,
    module: azureSdk,
  });
  const { writeUrl, readUrl } = await provider.allocateOutput();
  const write = new URL(writeUrl);
  const read = new URL(readUrl);
  expect(write.host).toBe(`${ACCOUNT}.blob.core.windows.net`);
  expect(write.pathname).toMatch(/^\/renders\/firefly-audio-video\/outputs\/[0-9a-f-]{36}$/);
  expect(read.pathname).toBe(write.pathname);
  expect(write.searchParams.get('sp')).toBe('cw');
  expect(read.searchParams.get('sp')).toBe('r');
  for (const url of [write, read]) {
    expect(url.searchParams.get('sr')).toBe('b');
    expect(url.searchParams.get('spr')).toBe('https');
    expect(url.searchParams.get('se')).toBe('2026-09-30T12:00:00Z');
    expect(url.searchParams.get('sig')).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  }
  expect(write.searchParams.get('sig')).not.toBe(read.searchParams.get('sig'));
});

test('with the real SDK, offline: a connection string signs the same way, and Azurite development storage signs over any protocol', async () => {
  const { writeUrl } = await new AzureBlobStorageProvider({
    container: CONTAINER,
    connectionString: CONNECTION_STRING,
    module: azureSdk,
  }).allocateOutput();
  expect(new URL(writeUrl).host).toBe(`${ACCOUNT}.blob.core.windows.net`);
  expect(new URL(writeUrl).searchParams.get('spr')).toBe('https');

  const { readUrl } = await new AzureBlobStorageProvider({
    container: CONTAINER,
    connectionString: 'UseDevelopmentStorage=true',
    module: azureSdk,
  }).allocateOutput();
  const read = new URL(readUrl);
  expect(`${read.origin}${read.pathname}`).toMatch(
    /^http:\/\/127\.0\.0\.1:10000\/devstoreaccount1\/renders\/firefly-audio-video\/outputs\//,
  );
  expect(read.searchParams.get('sp')).toBe('r');
  expect(read.searchParams.has('spr')).toBe(false);
});

test('with the real SDK, offline: an account name, key and endpoint sign for that endpoint', async () => {
  const { writeUrl } = await new AzureBlobStorageProvider({
    container: CONTAINER,
    accountName: 'devstoreaccount1',
    accountKey: ACCOUNT_KEY,
    endpoint: 'http://127.0.0.1:10000/devstoreaccount1',
    module: azureSdk,
  }).allocateOutput();
  const write = new URL(writeUrl);
  expect(`${write.origin}${write.pathname}`).toMatch(
    /^http:\/\/127\.0\.0\.1:10000\/devstoreaccount1\/renders\/firefly-audio-video\/outputs\/[0-9a-f-]{36}$/,
  );
  expect(write.searchParams.get('sp')).toBe('cw');
  expect(write.searchParams.get('sig')).toMatch(/^[A-Za-z0-9+/]{43}=$/);
});

test('with the real SDK, offline: a client without the account key cannot sign, and its SAS is never shown', async () => {
  const error = await rejection(
    new AzureBlobStorageProvider({
      container: CONTAINER,
      connectionString: SAS_CONNECTION_STRING,
      module: azureSdk,
    }).allocateOutput(),
  );
  expect(error.code).toBe('storage_failed');
  expect(error.message).toBe(
    'Signing a write SAS for the blob failed: Can only generate the SAS when the client is ' +
      'initialized with a shared key credential',
  );
  expect(everythingPrinted(error)).not.toContain('CONNECTION_STRING_SAS_SIG');
});

// --- the client ------------------------------------------------------------------------

test('the client this provider builds from an account name and key uses the default endpoint, or the one given, once', async () => {
  const store = fakeContainer();
  const { service } = fakeService(store.container);
  const recorded = recordingModule(service);
  const provider = new AzureBlobStorageProvider({
    container: CONTAINER,
    accountName: ACCOUNT,
    accountKey: ACCOUNT_KEY,
    module: recorded.module,
  });
  await provider.allocateOutput();
  await provider.stageRead(Buffer.from('x'));
  expect(recorded.built).toEqual([
    `DefaultEndpointsProtocol=https;AccountName=${ACCOUNT};AccountKey=${ACCOUNT_KEY};` +
      'EndpointSuffix=core.windows.net',
  ]);

  const azurite = recordingModule(service);
  await new AzureBlobStorageProvider({
    container: CONTAINER,
    accountName: 'devstoreaccount1',
    accountKey: ACCOUNT_KEY,
    endpoint: 'http://127.0.0.1:10000/devstoreaccount1',
    module: azurite.module,
  }).allocateOutput();
  expect(azurite.built).toEqual([
    `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${ACCOUNT_KEY};` +
      'BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1',
  ]);
});

test('a connection string builds the client through fromConnectionString, once', async () => {
  const store = fakeContainer();
  const { service } = fakeService(store.container);
  const recorded = recordingModule(service);
  const provider = new AzureBlobStorageProvider({
    container: CONTAINER,
    connectionString: CONNECTION_STRING,
    module: recorded.module,
  });
  await provider.allocateOutput();
  await provider.allocateOutput();
  expect(recorded.built).toEqual([CONNECTION_STRING]);
});

test('a client passed in is used as it is', async () => {
  const store = fakeContainer();
  const { service, opened } = fakeService(store.container);
  const recorded = recordingModule(fakeService(fakeContainer().container).service);
  await new AzureBlobStorageProvider({
    container: CONTAINER,
    client: service,
    module: recorded.module,
  }).stageRead(Buffer.from('x'));
  expect(recorded.built).toEqual([]);
  expect(opened).toEqual([CONTAINER]);
  expect(store.uploads).toHaveLength(1);
});

// --- failures, and what they print ------------------------------------------------------

test('an upload failure quoting the account key and a SAS rejects storage_failed with both removed from the error and its causes', async () => {
  const store = fakeContainer();
  const failing: AzureContainerClient = {
    getBlockBlobClient(name) {
      const blob = store.container.getBlockBlobClient(name);
      return {
        ...blob,
        url: blob.url,
        uploadData: () =>
          Promise.reject(
            Object.assign(
              new Error(
                `AuthorizationFailure for ${BLOB_BASE}/x?sv=2026&sp=cw&sig=SAS_UPLOAD_LEAK with key ${ACCOUNT_KEY}`,
              ),
              { name: 'RestError', cause: new Error(`signing with ${ACCOUNT_KEY}`) },
            ),
          ),
      };
    },
  };
  const error = await rejection(
    new AzureBlobStorageProvider({
      container: CONTAINER,
      accountName: ACCOUNT,
      accountKey: ACCOUNT_KEY,
      module: recordingModule(fakeService(failing).service).module,
    }).stageRead(Buffer.from('x')),
  );
  expect(error.code).toBe('storage_failed');
  expect(error.message).toBe(
    `Uploading the blob failed: AuthorizationFailure for ${BLOB_BASE}/x with key REDACTED`,
  );
  expect(((error.cause as Error).cause as Error).message).toBe('signing with REDACTED');
  expect((error.cause as Error).name).toBe('RestError');
  const printed = everythingPrinted(error);
  expect(printed).not.toContain(ACCOUNT_KEY);
  expect(printed).not.toContain('SAS_UPLOAD_LEAK');
  expect(store.sas).toEqual([]);
});

test('a signing, client or container failure quoting a connection string or its key has them scrubbed', async () => {
  const signing = await rejection(
    new AzureBlobStorageProvider({
      container: CONTAINER,
      accountName: ACCOUNT,
      accountKey: ACCOUNT_KEY,
      module: recordingModule(
        fakeService({
          getBlockBlobClient: (name) => ({
            ...fakeContainer().container.getBlockBlobClient(name),
            url: BLOB_BASE,
            generateSasUrl: () => Promise.reject(new Error(`cannot sign with ${ACCOUNT_KEY}`)),
          }),
        }).service,
      ).module,
    }).allocateOutput(),
  );
  expect(signing.message).toBe(
    'Signing a write SAS for the blob failed: cannot sign with REDACTED',
  );

  const refusing = recordingModule(fakeService(fakeContainer().container).service);
  refusing.module.BlobServiceClient.fromConnectionString = () => {
    throw new Error(`Invalid AccountKey ${ACCOUNT_KEY} in the connection string`);
  };
  const creating = await rejection(
    new AzureBlobStorageProvider({
      container: CONTAINER,
      connectionString: CONNECTION_STRING,
      module: refusing.module,
    }).allocateOutput(),
  );
  expect(creating.message).toBe(
    'Creating the Azure Blob client failed: Invalid AccountKey REDACTED in the connection string',
  );

  const echoing = recordingModule(fakeService(fakeContainer().container).service);
  echoing.module.BlobServiceClient.fromConnectionString = () => {
    throw new Error(`Cannot parse ${CONNECTION_STRING}`);
  };
  const whole = await rejection(
    new AzureBlobStorageProvider({
      container: CONTAINER,
      connectionString: CONNECTION_STRING,
      module: echoing.module,
    }).allocateOutput(),
  );
  expect(whole.message).toBe('Creating the Azure Blob client failed: Cannot parse REDACTED');

  const opening = await rejection(
    new AzureBlobStorageProvider({
      container: CONTAINER,
      accountName: ACCOUNT,
      accountKey: ACCOUNT_KEY,
      module: recordingModule({
        getContainerClient: () => {
          throw new Error(`no container for key ${ACCOUNT_KEY}`);
        },
      }).module,
    }).allocateOutput(),
  );
  expect(opening.message).toBe(
    'Opening the Azure Blob container failed: no container for key REDACTED',
  );

  const blob = await rejection(
    new AzureBlobStorageProvider({
      container: CONTAINER,
      connectionString: CONNECTION_STRING,
      module: recordingModule(
        fakeService({
          getBlockBlobClient: () => {
            throw new Error(`no blob client for ${ACCOUNT_KEY}`);
          },
        }).service,
      ).module,
    }).allocateOutput(),
  );
  expect(blob.message).toBe('Opening the blob failed: no blob client for REDACTED');

  for (const error of [signing, creating, whole, opening, blob]) {
    expect(error.code).toBe('storage_failed');
    const printed = everythingPrinted(error);
    expect(printed).not.toContain(ACCOUNT_KEY);
    expect(printed).not.toContain(CONNECTION_STRING);
  }
});

test('a failed SAS, or one resolving without an http(s) URL, rejects storage_failed', async () => {
  for (const answer of ['', 'not a url', 'ftp://example.com/b']) {
    const error = await rejection(
      new AzureBlobStorageProvider({
        container: CONTAINER,
        client: fakeService({
          getBlockBlobClient: (name) => ({
            ...fakeContainer().container.getBlockBlobClient(name),
            url: BLOB_BASE,
            generateSasUrl: async () => answer,
          }),
        }).service,
        module: azureSdk,
      }).allocateOutput(),
    );
    expect(error.code).toBe('storage_failed');
    expect(error.message).toBe(
      'generateSasUrl() resolved without an http(s) URL for the write SAS.',
    );
  }
});

test('no printed form of the provider, or of a client using it, shows the account key or connection string', () => {
  expect(printedForms({ held: ACCOUNT_KEY })).toContain(ACCOUNT_KEY);
  const providers = [
    new AzureBlobStorageProvider({
      container: CONTAINER,
      accountName: ACCOUNT,
      accountKey: ACCOUNT_KEY,
    }),
    new AzureBlobStorageProvider({ container: CONTAINER, connectionString: CONNECTION_STRING }),
    new AzureBlobStorageProvider({
      container: CONTAINER,
      connectionString: SAS_CONNECTION_STRING,
    }),
    new AzureBlobStorageProvider({
      container: CONTAINER,
      client: azureSdk.BlobServiceClient.fromConnectionString(CONNECTION_STRING),
    }),
  ];
  for (const provider of providers) {
    const client = createClient({
      clientId: 'id',
      clientSecret: 'secret',
      logging: false,
      storage: provider,
    });
    const printed = `${printedForms(provider)}\n${printedForms(client)}`;
    expect(printed).not.toContain(ACCOUNT_KEY);
    expect(printed).not.toContain('CONNECTION_STRING_SAS_SIG');
  }
});

// --- what is refused -----------------------------------------------------------------------

test('invalid options throw invalid_argument without quoting a key or connection string', () => {
  const service = fakeService(fakeContainer().container).service;
  for (const options of [
    null,
    {},
    { container: '', connectionString: CONNECTION_STRING },
    { container: CONTAINER },
    { container: CONTAINER, connectionString: CONNECTION_STRING, client: service },
    { container: CONTAINER, connectionString: CONNECTION_STRING, accountName: ACCOUNT },
    { container: CONTAINER, accountKey: ACCOUNT_KEY, client: service },
    { container: CONTAINER, connectionString: ' ' },
    { container: CONTAINER, accountName: ACCOUNT },
    { container: CONTAINER, accountKey: ACCOUNT_KEY },
    { container: CONTAINER, accountName: 'Fav-Acct', accountKey: ACCOUNT_KEY },
    { container: CONTAINER, accountName: ACCOUNT, accountKey: ' ' },
    { container: CONTAINER, accountName: ACCOUNT, accountKey: ACCOUNT_KEY, endpoint: 'ftp://x' },
    { container: CONTAINER, accountName: ACCOUNT, accountKey: `${ACCOUNT_KEY};BlobEndpoint=x` },
    {
      container: CONTAINER,
      accountName: ACCOUNT,
      accountKey: ACCOUNT_KEY,
      endpoint: 'https://x.example/a;BlobEndpoint=https://y.example',
    },
    { container: CONTAINER, client: service, endpoint: 'https://x.example' },
    { container: CONTAINER, client: {} },
    { container: CONTAINER, client: service, expiresIn: 0 },
    { container: CONTAINER, client: service, expiresIn: 604_801 },
    { container: CONTAINER, client: service, prefix: 7 },
  ]) {
    const error = thrown(() => new AzureBlobStorageProvider(options as never));
    expect(error.code).toBe('invalid_argument');
    expect(error.message).not.toContain(ACCOUNT_KEY);
    expect(error.message).not.toContain('AccountKey');
  }
});

test('invalid arguments reject invalid_argument before any SDK call', async () => {
  const { provider, uploads, sas, opened } = fakeProvider();
  for (const call of [
    () => provider.stageRead('https://example.com/a.png'),
    () => provider.stageRead('./no-such-file.png'),
    () => provider.stageRead(Buffer.from('x'), { expiresIn: 1.5 }),
    () => provider.stageRead(Buffer.from('x'), { contentType: '' }),
    () => provider.allocateOutput({ key: '' }),
    () => provider.allocateOutput({ expiresIn: 604_801 }),
  ]) {
    expect((await rejection(call())).code).toBe('invalid_argument');
  }
  expect([uploads, sas, opened]).toEqual([[], [], []]);
});

// --- loading the SDK ------------------------------------------------------------------------

test('without module, the SDK is loaded by name on first use — never at construction — and once', async () => {
  const store = fakeContainer();
  const recorded = recordingModule(fakeService(store.container).service);
  vi.mocked(loadPeer).mockResolvedValue(recorded.module);
  const provider = new AzureBlobStorageProvider({
    container: CONTAINER,
    accountName: ACCOUNT,
    accountKey: ACCOUNT_KEY,
  });
  expect(loadPeer).not.toHaveBeenCalled();
  await provider.allocateOutput();
  await provider.allocateOutput();
  expect(loadPeer).toHaveBeenCalledTimes(1);
  expect(vi.mocked(loadPeer).mock.calls[0]?.[0]).toMatchObject({
    specifier: '@azure/storage-blob',
    install: 'npm install @azure/storage-blob',
  });
});

test('a missing @azure/storage-blob rejects missing_peer_dependency naming the install command', async () => {
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
    new AzureBlobStorageProvider({
      container: CONTAINER,
      connectionString: CONNECTION_STRING,
    }).stageRead(Buffer.from('x')),
  );
  expect(error.code).toBe('missing_peer_dependency');
  expect(error.message).toContain('AzureBlobStorageProvider needs @azure/storage-blob');
  expect(error.message).toContain('`npm install @azure/storage-blob`');
  expect(error.message).toContain('pass the module as the module option instead');
});

test('a failed load is retried on the next call', async () => {
  const recorded = recordingModule(fakeService(fakeContainer().container).service);
  let attempts = 0;
  vi.mocked(loadPeer).mockImplementation(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new AudioVideoError({ message: 'not yet', code: 'missing_peer_dependency' });
    }
    return recorded.module;
  });
  const provider = new AzureBlobStorageProvider({
    container: CONTAINER,
    connectionString: CONNECTION_STRING,
  });
  await rejection(provider.allocateOutput());
  await expect(provider.allocateOutput()).resolves.toHaveProperty('readUrl');
  expect(attempts).toBe(2);
});

test('a module missing what the provider calls rejects storage_failed naming it', async () => {
  const service = fakeService(fakeContainer().container).service;
  const base = recordingModule(service).module;
  const cases: Array<[Record<string, unknown>, object, string]> = [
    [
      { BlobServiceClient: base.BlobServiceClient },
      { client: service },
      '@azure/storage-blob does not export BlobSASPermissions, which AzureBlobStorageProvider needs.',
    ],
    [
      { ...base, BlobSASPermissions: {} },
      { client: service },
      '@azure/storage-blob exports a BlobSASPermissions without parse().',
    ],
    [
      { ...base, BlobServiceClient: 'nope' },
      { connectionString: CONNECTION_STRING },
      '@azure/storage-blob exports a BlobServiceClient without fromConnectionString().',
    ],
    [
      { ...base, BlobServiceClient: { fromConnectionString: () => ({}) } },
      { accountName: ACCOUNT, accountKey: ACCOUNT_KEY },
      'fromConnectionString() returned no service client.',
    ],
  ];
  for (const [module, source, message] of cases) {
    const error = await rejection(
      new AzureBlobStorageProvider({
        container: CONTAINER,
        ...source,
        module: module as unknown as AzureBlobModule,
      } as never).allocateOutput(),
    );
    expect(error.code).toBe('storage_failed');
    expect(error.message).toBe(message);
  }
  const noContainer = await rejection(
    new AzureBlobStorageProvider({
      container: CONTAINER,
      client: { getContainerClient: () => ({}) as never },
      module: azureSdk,
    }).allocateOutput(),
  );
  expect(noContainer.message).toBe('getContainerClient() returned no container client.');
});
