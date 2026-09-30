import { Console } from 'node:console';
import { ReadStream, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { inspect } from 'node:util';
import * as s3Sdk from '@aws-sdk/client-s3';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import * as presignerSdk from '@aws-sdk/s3-request-presigner';
import type { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterAll, afterEach, beforeAll, beforeEach, expect, expectTypeOf, test, vi } from 'vitest';
import { AudioVideoError } from '../src/core/errors.js';
import { createClient } from '../src/dgr/client.js';
import { loadPeer, type Peer } from '../src/storage/peer.js';
import {
  S3StorageProvider,
  type S3ClientLike,
  type S3ClientModule,
  type S3PresignerModule,
} from '../src/storage/s3.js';

vi.mock('../src/storage/peer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/storage/peer.js')>();
  return {
    ...actual,
    loadPeer: vi.fn(() => Promise.reject(new Error('loadPeer is not stubbed in this test'))),
  };
});

const BUCKET = 'fav-bucket';
const AWS_ENV = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_PROFILE',
];
const CREDENTIALS = {
  accessKeyId: 'AKIAFAKEACCESSKEYID0',
  secretAccessKey: 'FAKE_SECRET_ACCESS_KEY_VALUE_0123456789',
  sessionToken: 'FAKE_SESSION_TOKEN_VALUE_0123456789',
};
const CREDENTIAL_VALUES = Object.values(CREDENTIALS);

let dir: string;
let logo: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fav-s3-'));
  logo = join(dir, 'logo.png');
  writeFileSync(logo, 'png bytes on disk');
});

afterAll(() => {
  unlinkSync(logo);
  rmdirSync(dir);
});

beforeEach(() => {
  for (const name of AWS_ENV) vi.stubEnv(name, '');
  // The SDK's default chain must never find a real profile or instance role on this machine.
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', join(dir, 'no-such-credentials'));
  vi.stubEnv('AWS_CONFIG_FILE', join(dir, 'no-such-config'));
  vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(loadPeer).mockReset();
  vi.mocked(loadPeer).mockImplementation(() =>
    Promise.reject(new Error('loadPeer is not stubbed in this test')),
  );
});

/**
 * A fake S3 client: records every command and the options it was sent with,
 * reads a streamed body to its end, and answers `answer`.
 */
function fakeClient(answer: (command: object) => Promise<unknown> = async () => ({})) {
  const sent: object[] = [];
  const options: unknown[] = [];
  const bodies: string[] = [];
  return {
    sent,
    options,
    bodies,
    async send(command: object, sendOptions?: { abortSignal?: AbortSignal }): Promise<unknown> {
      sent.push(command);
      options.push(sendOptions);
      const body = (command as { input?: { Body?: unknown } }).input?.Body;
      if (body instanceof Readable) {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
        bodies.push(Buffer.concat(chunks).toString('utf8'));
      } else if (Buffer.isBuffer(body)) {
        bodies.push(body.toString('utf8'));
      }
      return answer(command);
    },
  };
}

/** A fake presigner with the SDK's own `getSignedUrl` signature, answering SigV4-shaped URLs. */
function fakePresigner() {
  const calls: Array<{ client: unknown; command: object; options: unknown }> = [];
  const fake: typeof getSignedUrl = async (client, command, options) => {
    calls.push({ client, command, options });
    const { Bucket, Key } = command.input as unknown as { Bucket: string; Key: string };
    const operation = command instanceof PutObjectCommand ? 'PutObject' : 'GetObject';
    return (
      `https://${Bucket}.s3.us-east-1.amazonaws.com/${Key}?X-Amz-Algorithm=AWS4-HMAC-SHA256` +
      `&X-Amz-Expires=${options?.expiresIn}&X-Amz-Signature=SIG_${operation}_${calls.length}` +
      `&X-Amz-SignedHeaders=host&x-id=${operation}`
    );
  };
  return { calls, module: { getSignedUrl: fake } };
}

/** An `S3Client` stand-in class recording the config each instance is built with. */
function recordingClientClass(client: S3ClientLike) {
  const configs: unknown[] = [];
  class RecordingS3Client {
    constructor(config: unknown) {
      configs.push(config);
    }
    send(command: object, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
      return client.send(command, options);
    }
  }
  return { configs, RecordingS3Client };
}

/** The real command classes with a recording client class, as the s3 option takes them. */
function s3Module(client: S3ClientLike) {
  const { configs, RecordingS3Client } = recordingClientClass(client);
  const module: S3ClientModule = {
    S3Client: RecordingS3Client,
    PutObjectCommand,
    GetObjectCommand,
  };
  return { configs, module };
}

/** One HTTP request as the real SDK hands it to its request handler. */
interface SentRequest {
  method: string;
  hostname: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** A request body read to its end: bytes, a string, or a stream. */
async function bodyText(body: unknown): Promise<string> {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The real `@aws-sdk/client-s3` module whose `S3Client` keeps every setting
 * the provider gives it but sends its requests to a recording handler that
 * answers 200, never to the network. `handlerOptions` holds what the SDK
 * handed the handler alongside each request.
 */
function offlineSdk() {
  const requests: SentRequest[] = [];
  const handlerOptions: Array<{ abortSignal?: unknown } | undefined> = [];
  const requestHandler = {
    async handle(
      request: Omit<SentRequest, 'body'> & { body?: unknown },
      options?: { abortSignal?: unknown },
    ) {
      const { method, hostname, path, headers } = request;
      handlerOptions.push(options);
      requests.push({ method, hostname, path, headers, body: await bodyText(request.body) });
      return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } };
    },
  };
  class OfflineS3Client extends S3Client {
    constructor(config: ConstructorParameters<typeof S3Client>[0]) {
      super({ ...config, requestHandler });
    }
  }
  return { requests, handlerOptions, module: { ...s3Sdk, S3Client: OfflineS3Client } };
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

/** The `Bucket` and `Key` a recorded command carries. */
function objectOf(command: unknown): { Bucket: string; Key: string } {
  const { Bucket, Key } = (command as { input: { Bucket: string; Key: string } }).input;
  return { Bucket, Key };
}

const STAGED_KEY = /^firefly-audio-video\/staged\/[0-9a-f-]{36}$/;
const OUTPUT_KEY = /^firefly-audio-video\/outputs\/[0-9a-f-]{36}$/;

test('the provider option types are satisfied by the real SDK', () => {
  expectTypeOf<typeof s3Sdk>().toExtend<S3ClientModule>();
  expectTypeOf<typeof presignerSdk>().toExtend<S3PresignerModule>();
  expectTypeOf<S3Client>().toExtend<S3ClientLike>();
});

// --- stageRead -------------------------------------------------------------------------

test('stageRead sends PutObject with the bytes, then returns a presigned GET of the same key', async () => {
  const client = fakeClient();
  const presigner = fakePresigner();
  const provider = new S3StorageProvider({
    bucket: BUCKET,
    client,
    presigner: presigner.module,
    s3: s3Module(client).module,
  });

  const url = await provider.stageRead(Buffer.from('png bytes'), { contentType: 'image/png' });

  expect(client.sent).toHaveLength(1);
  const put = client.sent[0] as PutObjectCommand;
  expect(put).toBeInstanceOf(PutObjectCommand);
  expect(put.input.Bucket).toBe(BUCKET);
  expect(put.input.Key).toMatch(STAGED_KEY);
  expect(put.input.ContentLength).toBe(9);
  expect(put.input.ContentType).toBe('image/png');
  expect(client.bodies).toEqual(['png bytes']);
  expect(presigner.calls).toHaveLength(1);
  expect(presigner.calls[0]?.command).toBeInstanceOf(GetObjectCommand);
  expect(objectOf(presigner.calls[0]?.command)).toEqual({ Bucket: BUCKET, Key: put.input.Key });
  expect(presigner.calls[0]?.options).toEqual({ expiresIn: 3600 });
  expect(presigner.calls[0]?.client).toBe(client);
  expect(url).toMatch(/X-Amz-Signature=SIG_GetObject_1/);
});

test('a file streams from disk with its length, under a key that keeps its name', async () => {
  const client = fakeClient();
  const presigner = fakePresigner();
  await new S3StorageProvider({
    bucket: BUCKET,
    client,
    presigner: presigner.module,
    s3: s3Module(client).module,
  }).stageRead(logo);
  const put = client.sent[0] as PutObjectCommand;
  expect(put.input.Body).toBeInstanceOf(ReadStream);
  expect(put.input.ContentLength).toBe('png bytes on disk'.length);
  expect(put.input.Key).toMatch(/^firefly-audio-video\/staged\/[0-9a-f-]{36}\/logo\.png$/);
  expect(client.bodies).toEqual(['png bytes on disk']);
});

test('a Readable is read in full and sent as bytes with its length', async () => {
  const client = fakeClient();
  await new S3StorageProvider({
    bucket: BUCKET,
    client,
    presigner: fakePresigner().module,
    s3: s3Module(client).module,
  }).stageRead(Readable.from([Buffer.from('par'), Buffer.from('ts')]));
  const put = client.sent[0] as PutObjectCommand;
  expect(Buffer.isBuffer(put.input.Body)).toBe(true);
  expect(put.input.ContentLength).toBe(5);
  expect(client.bodies).toEqual(['parts']);
});

test('stageRead hands its signal to the PutObject as the abortSignal, which the real SDK passes to its request handler', async () => {
  const client = fakeClient();
  const controller = new AbortController();
  const provider = new S3StorageProvider({
    bucket: BUCKET,
    client,
    presigner: fakePresigner().module,
    s3: s3Module(client).module,
  });
  await provider.stageRead(Buffer.from('x'), { signal: controller.signal });
  await provider.stageRead(Buffer.from('y'));
  const [withSignal, withoutSignal] = client.options as Array<
    { abortSignal?: unknown } | undefined
  >;
  expect(client.options).toHaveLength(2);
  expect(withSignal?.abortSignal).toBe(controller.signal);
  expect(withoutSignal).toBeUndefined();

  const offline = offlineSdk();
  await new S3StorageProvider({
    bucket: BUCKET,
    region: 'us-east-1',
    credentials: CREDENTIALS,
    s3: offline.module,
    presigner: presignerSdk,
  }).stageRead(Buffer.from('x'), { signal: controller.signal });
  expect(offline.handlerOptions).toHaveLength(1);
  expect(offline.handlerOptions[0]?.abortSignal).toBe(controller.signal);
});

// --- allocateOutput ---------------------------------------------------------------------

test('allocateOutput presigns a PUT and a GET of one key, for 24 hours, and uploads nothing', async () => {
  const client = fakeClient();
  const presigner = fakePresigner();
  const slot = await new S3StorageProvider({
    bucket: BUCKET,
    client,
    presigner: presigner.module,
    s3: s3Module(client).module,
  }).allocateOutput();
  const [write, read] = presigner.calls;
  expect(write?.command).toBeInstanceOf(PutObjectCommand);
  expect(read?.command).toBeInstanceOf(GetObjectCommand);
  expect(objectOf(write?.command).Key).toMatch(OUTPUT_KEY);
  expect(objectOf(read?.command)).toEqual(objectOf(write?.command));
  expect(write?.options).toEqual({ expiresIn: 86400 });
  expect(read?.options).toEqual({ expiresIn: 86400 });
  expect(slot.writeUrl).toMatch(/x-id=PutObject$/);
  expect(slot.readUrl).toMatch(/x-id=GetObject$/);
  expect(client.sent).toEqual([]);
});

test('key, expiresIn and prefix name the object and its lifetime', async () => {
  const client = fakeClient();
  const presigner = fakePresigner();
  const s3 = s3Module(client).module;
  await new S3StorageProvider({
    bucket: BUCKET,
    client,
    presigner: presigner.module,
    s3,
  }).allocateOutput({ key: 'renders/out.mov', expiresIn: 600 });
  await new S3StorageProvider({
    bucket: BUCKET,
    client,
    presigner: presigner.module,
    s3,
    prefix: 'tenant-a',
    expiresIn: 7200,
  }).allocateOutput();
  expect(presigner.calls.map((call) => objectOf(call.command).Key)).toEqual([
    'firefly-audio-video/renders/out.mov',
    'firefly-audio-video/renders/out.mov',
    expect.stringMatching(/^tenant-a\/outputs\//),
    expect.stringMatching(/^tenant-a\/outputs\//),
  ]);
  expect(presigner.calls.map((call) => call.options)).toEqual([
    { expiresIn: 600 },
    { expiresIn: 600 },
    { expiresIn: 7200 },
    { expiresIn: 7200 },
  ]);
});

// --- the client ------------------------------------------------------------------------

test('the client this provider builds asks for checksums only when required, with the given region and credentials, once', async () => {
  const client = fakeClient();
  const { configs, module } = s3Module(client);
  const provider = new S3StorageProvider({
    bucket: BUCKET,
    region: 'eu-west-1',
    credentials: CREDENTIALS,
    s3: module,
    presigner: fakePresigner().module,
  });
  await provider.allocateOutput();
  await provider.stageRead(Buffer.from('x'));
  expect(configs).toEqual([
    { region: 'eu-west-1', credentials: CREDENTIALS, requestChecksumCalculation: 'WHEN_REQUIRED' },
  ]);

  const bare = s3Module(client);
  await new S3StorageProvider({
    bucket: BUCKET,
    s3: bare.module,
    presigner: fakePresigner().module,
  }).allocateOutput();
  expect(bare.configs).toEqual([{ requestChecksumCalculation: 'WHEN_REQUIRED' }]);
});

test('a client passed in is used as it is', async () => {
  const client = fakeClient();
  const { configs, module } = s3Module(fakeClient());
  await new S3StorageProvider({
    bucket: BUCKET,
    client,
    s3: module,
    presigner: fakePresigner().module,
  }).stageRead(Buffer.from('x'));
  expect(configs).toEqual([]);
  expect(client.sent).toHaveLength(1);
});

test('with the real SDK, offline: the presigned PUT carries no checksum and both URLs name the object', async () => {
  vi.stubEnv('AWS_ACCESS_KEY_ID', CREDENTIALS.accessKeyId);
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', CREDENTIALS.secretAccessKey);
  const provider = new S3StorageProvider({
    bucket: BUCKET,
    region: 'us-east-1',
    s3: s3Sdk,
    presigner: presignerSdk,
  });
  const { writeUrl, readUrl } = await provider.allocateOutput();
  const write = new URL(writeUrl);
  const read = new URL(readUrl);
  expect(write.host).toBe(`${BUCKET}.s3.us-east-1.amazonaws.com`);
  expect(write.pathname).toMatch(/^\/firefly-audio-video\/outputs\/[0-9a-f-]{36}$/);
  expect(read.pathname).toBe(write.pathname);
  expect(write.searchParams.get('x-id')).toBe('PutObject');
  expect(read.searchParams.get('x-id')).toBe('GetObject');
  expect(write.searchParams.get('X-Amz-Expires')).toBe('86400');
  expect(write.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  expect([...write.searchParams.keys()].filter((name) => /checksum/i.test(name))).toEqual([]);
});

test('with the real SDK, offline: the client built from credentials uploads each input in one plain PUT of its bytes, with no checksum', async () => {
  const { requests, module } = offlineSdk();
  const provider = new S3StorageProvider({
    bucket: BUCKET,
    region: 'us-east-1',
    credentials: CREDENTIALS,
    s3: module,
    presigner: presignerSdk,
  });

  const staged = await provider.stageRead(Buffer.from('png bytes'), { contentType: 'image/png' });
  await provider.stageRead(logo);

  expect(requests).toHaveLength(2);
  const [bytes, file] = requests;
  expect(bytes).toMatchObject({
    method: 'PUT',
    hostname: `${BUCKET}.s3.us-east-1.amazonaws.com`,
    body: 'png bytes',
  });
  expect(bytes?.path).toMatch(/^\/firefly-audio-video\/staged\/[0-9a-f-]{36}$/);
  expect(bytes?.headers['content-length']).toBe('9');
  expect(bytes?.headers['content-type']).toBe('image/png');
  expect(bytes?.headers['x-amz-security-token']).toBe(CREDENTIALS.sessionToken);
  expect(bytes?.headers.authorization).toContain(`Credential=${CREDENTIALS.accessKeyId}/`);
  expect(file?.path).toMatch(/^\/firefly-audio-video\/staged\/[0-9a-f-]{36}\/logo\.png$/);
  expect(file?.headers['content-length']).toBe(String('png bytes on disk'.length));
  expect(file?.body).toBe('png bytes on disk');
  for (const request of requests) {
    const names = Object.keys(request.headers).map((name) => name.toLowerCase());
    expect(names.filter((name) => /checksum|trailer|decoded-content-length/.test(name))).toEqual(
      [],
    );
    expect(request.headers['content-encoding']).toBeUndefined();
  }
  const read = new URL(staged);
  expect(read.pathname).toBe(bytes?.path);
  expect(read.searchParams.get('x-id')).toBe('GetObject');
  expect(read.searchParams.get('X-Amz-Credential')?.startsWith(`${CREDENTIALS.accessKeyId}/`)).toBe(
    true,
  );
});

test("a client passed in that signs PUTs with the SDK's default empty-body checksum is refused", async () => {
  const defaults = new S3Client({ region: 'us-east-1', credentials: CREDENTIALS });
  const error = await rejection(
    new S3StorageProvider({
      bucket: BUCKET,
      client: defaults,
      s3: s3Sdk,
      presigner: presignerSdk,
    }).allocateOutput(),
  );
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain("requestChecksumCalculation: 'WHEN_REQUIRED'");

  const fixed = new S3Client({
    region: 'us-east-1',
    credentials: CREDENTIALS,
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  await expect(
    new S3StorageProvider({
      bucket: BUCKET,
      client: fixed,
      s3: s3Sdk,
      presigner: presignerSdk,
    }).allocateOutput(),
  ).resolves.toHaveProperty('writeUrl');
});

test('a write URL naming a checksum algorithm or value, in any letter case, is refused before the read URL is signed', async () => {
  for (const parameter of ['x-amz-sdk-checksum-algorithm=CRC32', 'X-Amz-Checksum-Sha256=abc%3D']) {
    const client = fakeClient();
    const signed: string[] = [];
    const presigner: S3PresignerModule = {
      async getSignedUrl(_client, command) {
        const operation = command instanceof PutObjectCommand ? 'PutObject' : 'GetObject';
        signed.push(operation);
        return `https://${BUCKET}.s3.amazonaws.com/k?X-Amz-Signature=abc&${parameter}&x-id=${operation}`;
      },
    };
    const error = await rejection(
      new S3StorageProvider({
        bucket: BUCKET,
        client,
        s3: s3Module(client).module,
        presigner,
      }).allocateOutput(),
    );
    expect(error.code).toBe('invalid_argument');
    expect(signed).toEqual(['PutObject']);
  }
});

// --- failures, and what they print ------------------------------------------------------

test('a failed upload rejects storage_failed with its reason, redacted, and presigns nothing', async () => {
  const leak = `https://${BUCKET}.s3.amazonaws.com/k?X-Amz-Credential=AKIAFAKE&X-Amz-Signature=SIG_UPLOAD_LEAK`;
  const client = fakeClient(() =>
    Promise.reject(Object.assign(new Error(`Access Denied for ${leak}`), { name: 'AccessDenied' })),
  );
  const presigner = fakePresigner();
  const error = await rejection(
    new S3StorageProvider({
      bucket: BUCKET,
      client,
      presigner: presigner.module,
      s3: s3Module(client).module,
    }).stageRead(Buffer.from('x')),
  );
  expect(error.code).toBe('storage_failed');
  expect(
    error.message.startsWith('Uploading the object to S3 failed: Access Denied for https://'),
  ).toBe(true);
  expect(everythingPrinted(error)).not.toContain('SIG_UPLOAD_LEAK');
  expect((error.cause as Error).name).toBe('AccessDenied');
  expect(presigner.calls).toEqual([]);
});

test('an upload failure quoting the credentials has every one of them scrubbed from the error and its causes', async () => {
  const quoted = `key ${CREDENTIALS.accessKeyId}, secret ${CREDENTIALS.secretAccessKey}, token ${CREDENTIALS.sessionToken}`;
  const client = fakeClient(() =>
    Promise.reject(
      Object.assign(new Error(`Access Denied signing with ${quoted}`), {
        name: 'AccessDenied',
        cause: new Error(`while signing with ${quoted}`),
      }),
    ),
  );
  const error = await rejection(
    new S3StorageProvider({
      bucket: BUCKET,
      credentials: CREDENTIALS,
      client,
      presigner: fakePresigner().module,
      s3: s3Module(client).module,
    }).stageRead(Buffer.from('x')),
  );
  expect(error.code).toBe('storage_failed');
  expect(error.message).toBe(
    'Uploading the object to S3 failed: Access Denied signing with key REDACTED, secret ' +
      'REDACTED, token REDACTED',
  );
  expect(((error.cause as Error).cause as Error).message).toBe(
    'while signing with key REDACTED, secret REDACTED, token REDACTED',
  );
  const printed = everythingPrinted(error);
  for (const value of CREDENTIAL_VALUES) expect(printed).not.toContain(value);
});

test('a presign or client construction failure quoting the credentials has them scrubbed too', async () => {
  const quoted = `${CREDENTIALS.secretAccessKey} with ${CREDENTIALS.sessionToken}`;
  const client = fakeClient();
  const presigner: S3PresignerModule = {
    getSignedUrl: () => Promise.reject(new Error(`cannot sign with ${quoted}`)),
  };
  const signing = await rejection(
    new S3StorageProvider({
      bucket: BUCKET,
      credentials: CREDENTIALS,
      client,
      presigner,
      s3: s3Module(client).module,
    }).allocateOutput(),
  );
  expect(signing.message).toBe(
    'Presigning a PUT of the object failed: cannot sign with REDACTED with REDACTED',
  );

  class RefusingS3Client {
    constructor() {
      throw new Error(`invalid configuration: ${quoted}`);
    }
    send(): Promise<unknown> {
      return Promise.resolve({});
    }
  }
  const creating = await rejection(
    new S3StorageProvider({
      bucket: BUCKET,
      credentials: CREDENTIALS,
      presigner: fakePresigner().module,
      s3: { ...s3Module(client).module, S3Client: RefusingS3Client },
    }).allocateOutput(),
  );
  expect(creating.message).toBe(
    'Creating the S3 client failed: invalid configuration: REDACTED with REDACTED',
  );
  for (const error of [signing, creating]) {
    const printed = everythingPrinted(error);
    for (const value of CREDENTIAL_VALUES) expect(printed).not.toContain(value);
  }
});

test('a file stream is closed whether its upload fails or succeeds', async () => {
  let failedBody: ReadStream | undefined;
  const failing = fakeClient(async (command) => {
    failedBody = (command as PutObjectCommand).input.Body as ReadStream;
    throw new Error('network down');
  });
  await rejection(
    new S3StorageProvider({
      bucket: BUCKET,
      client: failing,
      presigner: fakePresigner().module,
      s3: s3Module(failing).module,
    }).stageRead(logo),
  );
  expect(failedBody?.destroyed).toBe(true);

  let unreadBody: ReadStream | undefined;
  const unread: S3ClientLike = {
    async send(command) {
      unreadBody = (command as PutObjectCommand).input.Body as ReadStream;
      return {};
    },
  };
  await new S3StorageProvider({
    bucket: BUCKET,
    client: unread,
    presigner: fakePresigner().module,
    s3: s3Module(unread).module,
  }).stageRead(logo);
  expect(unreadBody?.destroyed).toBe(true);
});

test('a failed presign, or one resolving without an http(s) URL, rejects storage_failed', async () => {
  const client = fakeClient();
  const failing: S3PresignerModule = {
    getSignedUrl: () => Promise.reject(new Error('Region is missing')),
  };
  const error = await rejection(
    new S3StorageProvider({
      bucket: BUCKET,
      client,
      presigner: failing,
      s3: s3Module(client).module,
    }).allocateOutput(),
  );
  expect(error.code).toBe('storage_failed');
  expect(error.message).toBe('Presigning a PUT of the object failed: Region is missing');

  for (const answer of ['', 'not a url', 'ftp://example.com/k']) {
    const presigner: S3PresignerModule = { getSignedUrl: async () => answer };
    const none = await rejection(
      new S3StorageProvider({
        bucket: BUCKET,
        client,
        presigner,
        s3: s3Module(client).module,
      }).allocateOutput(),
    );
    expect(none.code).toBe('storage_failed');
    expect(none.message).toBe('getSignedUrl() resolved without an http(s) URL for the PUT.');
  }
});

test('no printed form of the provider, or of a client using it, shows a credential', () => {
  expect(printedForms({ held: CREDENTIALS.secretAccessKey })).toContain(
    CREDENTIALS.secretAccessKey,
  );
  const provider = new S3StorageProvider({
    bucket: BUCKET,
    region: 'us-east-1',
    credentials: CREDENTIALS,
    client: new S3Client({
      region: 'us-east-1',
      credentials: CREDENTIALS,
      requestChecksumCalculation: 'WHEN_REQUIRED',
    }),
  });
  const client = createClient({
    clientId: 'id',
    clientSecret: 'secret',
    logging: false,
    storage: provider,
  });
  const printed = `${printedForms(provider)}\n${printedForms(client)}`;
  for (const value of CREDENTIAL_VALUES) expect(printed).not.toContain(value);
});

// --- what is refused -----------------------------------------------------------------------

test('invalid options throw invalid_argument when constructed; invalid arguments reject before any SDK call', async () => {
  for (const options of [
    {},
    { bucket: '' },
    { bucket: 42 },
    { bucket: BUCKET, region: '' },
    { bucket: BUCKET, client: {} },
    { bucket: BUCKET, expiresIn: 0 },
    { bucket: BUCKET, expiresIn: 604_801 },
    { bucket: BUCKET, prefix: 7 },
  ]) {
    expect(() => new S3StorageProvider(options as never)).toThrow(AudioVideoError);
  }
  const client = fakeClient();
  const presigner = fakePresigner();
  const provider = new S3StorageProvider({
    bucket: BUCKET,
    client,
    presigner: presigner.module,
    s3: s3Module(client).module,
  });
  for (const call of [
    () => provider.stageRead('https://example.com/a.png'),
    () => provider.stageRead('./no-such-file.png'),
    () => provider.stageRead(Buffer.from('x'), { expiresIn: 1.5 }),
    () => provider.stageRead(Buffer.from('x'), { contentType: '' }),
    () => provider.allocateOutput({ key: '' }),
  ]) {
    expect((await rejection(call())).code).toBe('invalid_argument');
  }
  expect(client.sent).toEqual([]);
  expect(presigner.calls).toEqual([]);
});

test('invalid credentials throw invalid_argument without quoting any of them', () => {
  for (const credentials of [
    null,
    'AKIA:SECRET',
    { accessKeyId: CREDENTIALS.accessKeyId },
    { secretAccessKey: CREDENTIALS.secretAccessKey, sessionToken: CREDENTIALS.sessionToken },
    { ...CREDENTIALS, accessKeyId: ' ' },
    { ...CREDENTIALS, sessionToken: '' },
    { ...CREDENTIALS, sessionToken: 42 },
  ]) {
    const error = thrown(() => new S3StorageProvider({ bucket: BUCKET, credentials } as never));
    expect(error.code).toBe('invalid_argument');
    expect(error.message).toContain('credentials must hold a non-empty accessKeyId');
    for (const value of CREDENTIAL_VALUES) expect(error.message).not.toContain(value);
  }
});

// --- loading the SDK ------------------------------------------------------------------------

test('without s3 or presigner, both SDK packages are loaded by name on first use — never at construction', async () => {
  const client = fakeClient();
  const presigner = fakePresigner();
  const { module } = s3Module(client);
  vi.mocked(loadPeer).mockImplementation(async (peer: Peer) =>
    peer.specifier === '@aws-sdk/client-s3' ? module : presigner.module,
  );
  const provider = new S3StorageProvider({ bucket: BUCKET, region: 'us-east-1' });
  expect(loadPeer).not.toHaveBeenCalled();
  await provider.allocateOutput();
  await provider.allocateOutput();
  expect(vi.mocked(loadPeer).mock.calls.map(([peer]) => peer.specifier)).toEqual([
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
  ]);
});

test('a missing AWS SDK package rejects missing_peer_dependency naming both packages and the option that takes it', async () => {
  const actual =
    await vi.importActual<typeof import('../src/storage/peer.js')>('../src/storage/peer.js');
  vi.mocked(loadPeer).mockImplementation((peer: Peer) =>
    actual.loadPeer(peer, () =>
      Promise.reject(
        Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' }),
      ),
    ),
  );
  const both = await rejection(
    new S3StorageProvider({ bucket: BUCKET }).stageRead(Buffer.from('x')),
  );
  expect(both.code).toBe('missing_peer_dependency');
  expect(both.message).toContain('S3StorageProvider needs @aws-sdk/client-s3');
  expect(both.message).toContain('`npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`');
  expect(both.message).toContain('the s3 option');

  const presignerOnly = await rejection(
    new S3StorageProvider({ bucket: BUCKET, s3: s3Module(fakeClient()).module }).allocateOutput(),
  );
  expect(presignerOnly.message).toContain('needs @aws-sdk/s3-request-presigner');
  expect(presignerOnly.message).toContain('the presigner option');
});

test('an AWS SDK package that is installed but fails to load names the option that takes it, with the loader error redacted', async () => {
  const actual =
    await vi.importActual<typeof import('../src/storage/peer.js')>('../src/storage/peer.js');
  vi.mocked(loadPeer).mockImplementation((peer: Peer) =>
    actual.loadPeer(peer, () =>
      Promise.reject(new Error('refused at https://x.example/sdk.js?sig=LOAD_SIG_LEAK')),
    ),
  );
  const s3 = await rejection(new S3StorageProvider({ bucket: BUCKET }).stageRead(Buffer.from('x')));
  expect(s3.code).toBe('storage_failed');
  expect(s3.message).toBe(
    'Loading @aws-sdk/client-s3 for S3StorageProvider failed (Error: refused at ' +
      'https://x.example/sdk.js). Pass the module as the s3 option instead: a module passed in ' +
      'needs no run-time import.',
  );

  const presigner = await rejection(
    new S3StorageProvider({ bucket: BUCKET, s3: s3Module(fakeClient()).module }).allocateOutput(),
  );
  expect(presigner.message).toContain(
    'Loading @aws-sdk/s3-request-presigner for S3StorageProvider',
  );
  expect(presigner.message).toContain('Pass the module as the presigner option instead');
  for (const error of [s3, presigner])
    expect(everythingPrinted(error)).not.toContain('LOAD_SIG_LEAK');
});

test('a failed load is retried on the next call', async () => {
  const client = fakeClient();
  const presigner = fakePresigner();
  const { module } = s3Module(client);
  let attempts = 0;
  vi.mocked(loadPeer).mockImplementation(async (peer: Peer) => {
    attempts += 1;
    if (attempts === 1) {
      throw new AudioVideoError({ message: 'not yet', code: 'missing_peer_dependency' });
    }
    return peer.specifier === '@aws-sdk/client-s3' ? module : presigner.module;
  });
  const provider = new S3StorageProvider({ bucket: BUCKET });
  await rejection(provider.allocateOutput());
  await expect(provider.allocateOutput()).resolves.toHaveProperty('readUrl');
});

test('a module missing an export the provider calls rejects storage_failed naming it', async () => {
  const client = fakeClient();
  const incomplete = { S3Client: s3Module(client).module.S3Client, GetObjectCommand };
  const error = await rejection(
    new S3StorageProvider({
      bucket: BUCKET,
      client,
      s3: incomplete as unknown as S3ClientModule,
      presigner: fakePresigner().module,
    }).allocateOutput(),
  );
  expect(error.code).toBe('storage_failed');
  expect(error.message).toBe(
    '@aws-sdk/client-s3 does not export PutObjectCommand, which S3StorageProvider needs.',
  );

  const notAClass = { ...s3Module(client).module, S3Client: 'nope' };
  const wrong = await rejection(
    new S3StorageProvider({
      bucket: BUCKET,
      s3: notAClass as unknown as S3ClientModule,
      presigner: fakePresigner().module,
    }).allocateOutput(),
  );
  expect(wrong.message).toBe('@aws-sdk/client-s3 exports a S3Client that is not a function.');
});
