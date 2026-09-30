/**
 * A storage provider's failure never shows a credential it holds, in any
 * spelling an encoder could have given it: not in the error's message or any
 * printed form of it, and not on any level of its cause chain. Each provider
 * runs its four failure paths — initializing, presigning, reading a local
 * input file, and an upload failing in transit — and App Builder Files, which
 * reads a file's bytes itself before uploading them, a failure of that read
 * too, against fakes whose errors quote one held secret in one spelling on
 * every level of a three-level chain: a message, a `code`, and a string cause
 * below them.
 *
 * A leak is found by the secret's runs of letters and digits, which no
 * percent-encoding, form-decoding or base64url spelling changes: any of them
 * appearing anywhere means some spelling of the secret got through.
 */

import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import * as azureSdk from '@azure/storage-blob';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { AudioVideoError } from '../src/core/errors.js';
import { AioFilesStorageProvider, type AioFilesClient } from '../src/storage/aio-files.js';
import {
  AzureBlobStorageProvider,
  type AzureBlobModule,
  type AzureBlockBlobClient,
} from '../src/storage/azure.js';
import { S3StorageProvider, type S3ClientModule } from '../src/storage/s3.js';
import { adapterError } from '../src/storage/shared.js';

const BLOB = 'https://heldsecrets.blob.core.windows.net';
const AZURE_KEY = 'AzureKeyLeft+AzureKeyMiddle/AzureKeyRight==';
const S3_CREDENTIALS = {
  accessKeyId: 'AKIAHELDACCESSKEYID1',
  secretAccessKey: 'S3SecretLeft+S3SecretMiddle/S3SecretRight=',
  sessionToken: 'S3SessionLeft+S3SessionMiddle/S3SessionRight==',
};
const AIO_AUTH = 'aio-runtime-uuid:AioAuthLeft+AioAuthMiddle/AioAuthRight==';

/**
 * What the next `stat` calls do, in order: an error to reject with, or
 * `undefined` to pass the call through to the file system — as every call
 * does once the queue is empty. A file that is found and then cannot be read
 * is `[undefined, error]`.
 */
const statFailures = vi.hoisted((): Array<Error | undefined> => []);

/**
 * Errors the next reads of a file's bytes reject with, in order — through
 * `openAsBlob` where the runtime has it, else `readFile` — each read passing
 * through to the file system once the queue is empty.
 */
const byteReadFailures = vi.hoisted((): Error[] => []);

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: (async (...args: Parameters<typeof actual.stat>) => {
      const failure = statFailures.shift();
      if (failure !== undefined) throw failure;
      return actual.stat(...args);
    }) as typeof actual.stat,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      const failure = byteReadFailures.shift();
      if (failure !== undefined) throw failure;
      return actual.readFile(...args);
    }) as typeof actual.readFile,
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  if (typeof actual.openAsBlob !== 'function') return actual;
  return {
    ...actual,
    openAsBlob: (async (...args: Parameters<typeof actual.openAsBlob>) => {
      const failure = byteReadFailures.shift();
      if (failure !== undefined) throw failure;
      return actual.openAsBlob(...args);
    }) as typeof actual.openAsBlob,
  };
});

let agent: MockAgent;
const original = getGlobalDispatcher();
let dir: string;
let inputFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fav-held-secrets-'));
  inputFile = join(dir, 'input.mogrt');
  writeFileSync(inputFile, 'capsule bytes on disk');
});

afterAll(() => {
  unlinkSync(inputFile);
  rmdirSync(dir);
});

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  statFailures.length = 0;
  byteReadFailures.length = 0;
  await agent.close();
  setGlobalDispatcher(original);
});

/** `text` with the hex digits of every percent-escape in lowercase. */
function lowerHex(text: string): string {
  return text.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
}

/** `secret` without its trailing `=` padding. */
function unpadded(secret: string): string {
  return secret.replace(/=+$/, '');
}

/** The ways a third party's error text can spell a held secret. */
const SPELLINGS: ReadonlyArray<readonly [name: string, spell: (secret: string) => string]> = [
  ['raw', (secret) => `refused ${secret} as given`],
  [
    'raw, in a query string the redaction pass rewrites',
    (secret) => `failed for ${BLOB}/renders/x?sv=2026&sig=HELD_SIG&comp=${secret}`,
  ],
  ['percent-encoded', (secret) => `next=${encodeURIComponent(secret)}`],
  ['percent-encoded in lowercase hex', (secret) => `next=${lowerHex(encodeURIComponent(secret))}`],
  ['percent-encoded twice', (secret) => `next=${encodeURIComponent(encodeURIComponent(secret))}`],
  ['with only its + encoded', (secret) => `refused ${secret.replaceAll('+', '%2B')}`],
  ['form-decoded, a + read as a space', (secret) => `refused "${secret.replaceAll('+', ' ')}"`],
  [
    'in base64url',
    (secret) => `refused ${unpadded(secret).replaceAll('+', '-').replaceAll('/', '_')}`,
  ],
  ['without its padding', (secret) => `refused ${unpadded(secret)}.`],
];

/** A three-level failure quoting `text` on every level: a message, then a message and a code, then a string. */
function failure(text: string): Error {
  return Object.assign(new Error(`outer ${text}`), {
    name: 'RestError',
    cause: Object.assign(new Error(`middle ${text}`), {
      code: `E ${text}`,
      cause: `inner ${text}`,
    }),
  });
}

/** The runs of letters and digits in `secret` long enough to be its own: any of them showing is a leak. */
function pieces(secret: string): string[] {
  return secret.split(/[^A-Za-z0-9]+/).filter((piece) => piece.length >= 8);
}

/** Every place an error's text can be read from: its message, its printed forms, and each level of its cause chain. */
function surfaces(error: AudioVideoError): Array<[where: string, text: string]> {
  const found: Array<[string, string]> = [
    ['message', error.message],
    ['String(err)', String(error)],
    ['JSON.stringify(err)', JSON.stringify(error)],
    ['inspect(err)', inspect(error, { depth: null })],
  ];
  let level = 1;
  for (let cause: unknown = error.cause; cause !== undefined; level += 1) {
    if (!(cause instanceof Error)) {
      found.push([`cause level ${level}`, String(cause)]);
      break;
    }
    found.push(
      [`cause level ${level}, inspect`, inspect(cause, { depth: null, showHidden: true })],
      [`cause level ${level}, String`, String(cause)],
      [`cause level ${level}, JSON.stringify`, JSON.stringify(cause)],
    );
    cause = cause.cause;
  }
  return found;
}

/** The line of `text` a leaked `piece` sits on. */
function lineWith(text: string, piece: string): string {
  return text.split('\n').find((line) => line.includes(piece)) ?? text;
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

/** An Azure provider holding {@link AZURE_KEY}, over a fake module whose calls succeed unless `fail` says otherwise. */
function azure(fail: { client?: Error; sign?: Error; upload?: Error }): AzureBlobStorageProvider {
  const blob: AzureBlockBlobClient = {
    url: `${BLOB}/renders/x`,
    uploadData: async () => (fail.upload === undefined ? {} : Promise.reject(fail.upload)),
    uploadFile: async () => ({}),
    uploadStream: async () => ({}),
    generateSasUrl: async () =>
      fail.sign === undefined
        ? `${BLOB}/renders/x?sv=2026&sp=r&sig=HELD_SAS`
        : Promise.reject(fail.sign),
  };
  const module: AzureBlobModule = {
    BlobServiceClient: {
      fromConnectionString: () => {
        if (fail.client !== undefined) throw fail.client;
        return { getContainerClient: () => ({ getBlockBlobClient: () => blob }) };
      },
    },
    BlobSASPermissions: azureSdk.BlobSASPermissions,
  };
  return new AzureBlobStorageProvider({
    container: 'renders',
    accountName: 'heldsecrets',
    accountKey: AZURE_KEY,
    module,
  });
}

/** An S3 provider holding {@link S3_CREDENTIALS}, over fake modules whose calls succeed unless `fail` says otherwise. */
function s3(fail: { client?: Error; presign?: Error; upload?: Error }): S3StorageProvider {
  class HeldS3Client {
    constructor() {
      if (fail.client !== undefined) throw fail.client;
    }
    send(): Promise<unknown> {
      return fail.upload === undefined ? Promise.resolve({}) : Promise.reject(fail.upload);
    }
  }
  const module: S3ClientModule = { S3Client: HeldS3Client, PutObjectCommand, GetObjectCommand };
  return new S3StorageProvider({
    bucket: 'held-secrets',
    region: 'us-east-1',
    credentials: S3_CREDENTIALS,
    s3: module,
    presigner: {
      getSignedUrl: async () =>
        fail.presign === undefined
          ? 'https://held-secrets.s3.us-east-1.amazonaws.com/k?X-Amz-Signature=HELD_SIG'
          : Promise.reject(fail.presign),
    },
  });
}

/** An App Builder Files provider holding {@link AIO_AUTH}. */
function aioFiles(options: { files?: AioFilesClient; init?: Error }): AioFilesStorageProvider {
  const { files, init } = options;
  return new AioFilesStorageProvider({
    namespace: 'held-ns',
    auth: AIO_AUTH,
    ...(files !== undefined ? { files } : {}),
    ...(init !== undefined ? { module: { init: () => Promise.reject(init) } } : {}),
  });
}

/** A Files client presigning every key with a SAS-shaped URL on {@link BLOB}. */
const presigning: AioFilesClient = {
  generatePresignURL: async (key, options) =>
    `${BLOB}/fav/${key}?sv=2026&sp=${options.permissions}&sig=HELD_SIG`,
};

/** One provider failure path: the secrets the provider holds, and a run that fails with `thrown`. */
type FailurePath = readonly [
  provider: string,
  path: string,
  secrets: readonly string[],
  run: (thrown: Error) => Promise<unknown>,
];

const PATHS: readonly FailurePath[] = [
  ['Azure', 'initializing', [AZURE_KEY], (thrown) => azure({ client: thrown }).allocateOutput()],
  ['Azure', 'presigning', [AZURE_KEY], (thrown) => azure({ sign: thrown }).allocateOutput()],
  [
    'Azure',
    'reading the input file',
    [AZURE_KEY],
    (thrown) => {
      statFailures.push(undefined, thrown);
      return azure({}).stageRead(inputFile);
    },
  ],
  [
    'Azure',
    'an upload in transit',
    [AZURE_KEY],
    (thrown) => azure({ upload: thrown }).stageRead(Buffer.from('x')),
  ],
  [
    'S3',
    'initializing',
    Object.values(S3_CREDENTIALS),
    (thrown) => s3({ client: thrown }).allocateOutput(),
  ],
  [
    'S3',
    'presigning',
    Object.values(S3_CREDENTIALS),
    (thrown) => s3({ presign: thrown }).allocateOutput(),
  ],
  [
    'S3',
    'reading the input file',
    Object.values(S3_CREDENTIALS),
    (thrown) => {
      statFailures.push(undefined, thrown);
      return s3({}).stageRead(inputFile);
    },
  ],
  [
    'S3',
    'an upload in transit',
    Object.values(S3_CREDENTIALS),
    (thrown) => s3({ upload: thrown }).stageRead(Buffer.from('x')),
  ],
  [
    'App Builder Files',
    'initializing',
    [AIO_AUTH],
    (thrown) => aioFiles({ init: thrown }).allocateOutput(),
  ],
  [
    'App Builder Files',
    'presigning',
    [AIO_AUTH],
    (thrown) =>
      aioFiles({ files: { generatePresignURL: () => Promise.reject(thrown) } }).allocateOutput(),
  ],
  [
    'App Builder Files',
    'reading the input file',
    [AIO_AUTH],
    (thrown) => {
      statFailures.push(undefined, thrown);
      return aioFiles({ files: presigning }).stageRead(inputFile);
    },
  ],
  [
    'App Builder Files',
    "reading the input file's bytes",
    [AIO_AUTH],
    (thrown) => {
      byteReadFailures.push(thrown);
      return aioFiles({ files: presigning }).stageRead(inputFile);
    },
  ],
  [
    'App Builder Files',
    'an upload in transit',
    [AIO_AUTH],
    (thrown) => {
      agent
        .get(BLOB)
        .intercept({ path: (path) => path.startsWith('/fav/'), method: 'PUT' })
        .replyWithError(thrown);
      return aioFiles({ files: presigning }).stageRead(Buffer.from('x'));
    },
  ],
];

test('the leak check finds a held secret on a cause level, and every secret has pieces to find', () => {
  const leaking = new AudioVideoError({
    message: 'Uploading failed.',
    code: 'storage_failed',
    cause: new Error(`middle ${encodeURIComponent(AZURE_KEY)}`),
  });
  const hits = surfaces(leaking).filter(([, text]) =>
    pieces(AZURE_KEY).some((piece) => text.includes(piece)),
  );
  expect(hits.map(([where]) => where)).toEqual(['cause level 1, inspect', 'cause level 1, String']);
  for (const secret of [AZURE_KEY, ...Object.values(S3_CREDENTIALS), AIO_AUTH]) {
    expect(pieces(secret).length, secret).toBeGreaterThan(0);
  }
});

test.each(PATHS)(
  '%s: no spelling of a held secret survives a failure while %s, on any printed form or cause level',
  async (_provider, _path, secrets, run) => {
    const leaks: string[] = [];
    for (const secret of secrets) {
      for (const [spelling, spell] of SPELLINGS) {
        const error = await rejection(run(failure(spell(secret))));
        expect(error.code).toBe('storage_failed');
        const found = surfaces(error);
        // The failure reached the provider and its whole chain was kept: a check that never
        // sees the text it guards cannot fail.
        const everything = found.map(([, text]) => text).join('\n');
        expect(everything, spelling).toContain('middle ');
        expect(everything, spelling).toContain('inner ');
        for (const [where, text] of found) {
          const leaked = pieces(secret).find((piece) => text.includes(piece));
          if (leaked !== undefined)
            leaks.push(`${spelling} | ${where} | ${lineWith(text, leaked)}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  },
);

test('a held connection string is removed whole from the cause copy, as it is from the message', async () => {
  const connectionString =
    `DefaultEndpointsProtocol=https;AccountName=heldsecrets;AccountKey=${AZURE_KEY};` +
    'EndpointSuffix=core.windows.net';
  const provider = new AzureBlobStorageProvider({
    container: 'renders',
    connectionString,
    module: {
      BlobServiceClient: {
        fromConnectionString: () => {
          throw new Error(`Cannot parse ${connectionString}`);
        },
      },
      BlobSASPermissions: azureSdk.BlobSASPermissions,
    },
  });
  const error = await rejection(provider.allocateOutput());
  expect(error.message).toBe('Creating the Azure Blob client failed: Cannot parse REDACTED');
  expect((error.cause as Error).message).toBe('Cannot parse REDACTED');
});

test('a held secret that begins with another is removed whole, never cut after the shorter one', () => {
  const error = adapterError('Signing failed', new Error('refused SharedPrefix0123456789 here'), [
    'SharedPrefix',
    'SharedPrefix0123456789',
  ]);
  expect(error.message).toBe('Signing failed: refused REDACTED here');
  expect((error.cause as Error).message).toBe('refused REDACTED here');
});

test('a held secret of nothing but padding is removed where it appears, and matches nowhere else', () => {
  const error = adapterError('Signing failed', new Error('refused == here'), ['==']);
  expect(error.message).toBe('Signing failed: refused REDACTED here');
  expect((error.cause as Error).message).toBe('refused REDACTED here');
});
