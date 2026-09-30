import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { AudioVideoError } from '../src/core/errors.js';
import {
  PassthroughStorageProvider,
  normalizeAsset,
  type StageInput,
  type StorageProvider,
} from '../src/core/storage.js';

const SIGNED = 'https://acct.blob.core.windows.net/c/logo.png?sv=2021&sp=r&sig=READ_SIG';

let dir: string;
let file: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fav-storage-'));
  file = join(dir, 'logo.png');
  writeFileSync(file, 'png bytes');
});

afterAll(() => {
  unlinkSync(file);
  rmdirSync(dir);
});

/** A provider that records every call and answers with a URL naming the call. */
function recordingProvider(): StorageProvider & {
  calls: Array<{ input: unknown; opts: unknown }>;
  allocations: number;
} {
  const calls: Array<{ input: unknown; opts: unknown }> = [];
  const provider = {
    calls,
    allocations: 0,
    async stageRead(input: StageInput, opts?: unknown): Promise<string> {
      calls.push({ input, opts });
      return `https://storage.example/staged/${calls.length}?sig=STAGE_SIG`;
    },
    async allocateOutput(): Promise<{ writeUrl: string; readUrl: string }> {
      provider.allocations += 1;
      return { writeUrl: 'https://storage.example/w', readUrl: 'https://storage.example/r' };
    },
  };
  return provider;
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

// --- URLs pass through ------------------------------------------------------------------

test('an http(s) URL string passes through untouched, with no storage call', async () => {
  const provider = recordingProvider();
  await expect(normalizeAsset(SIGNED, provider)).resolves.toBe(SIGNED);
  await expect(normalizeAsset('http://localhost:8080/a.mov', provider)).resolves.toBe(
    'http://localhost:8080/a.mov',
  );
  await expect(normalizeAsset(SIGNED)).resolves.toBe(SIGNED);
  expect(provider.calls).toEqual([]);
});

test('an http(s) URL object passes through as its href, with no storage call', async () => {
  const provider = recordingProvider();
  await expect(normalizeAsset(new URL(SIGNED), provider)).resolves.toBe(new URL(SIGNED).href);
  await expect(normalizeAsset(new URL(SIGNED))).resolves.toBe(new URL(SIGNED).href);
  expect(provider.calls).toEqual([]);
});

// --- everything else is staged ----------------------------------------------------------

test('a Buffer is staged through the provider as the same Buffer, and its read URL returned', async () => {
  const provider = recordingProvider();
  const bytes = Buffer.from('capsule bytes');
  await expect(normalizeAsset(bytes, provider)).resolves.toBe(
    'https://storage.example/staged/1?sig=STAGE_SIG',
  );
  expect(provider.calls).toHaveLength(1);
  expect(provider.calls[0]?.input).toBe(bytes);
  expect(provider.calls[0]?.opts).toEqual({});
});

test('a Readable is staged through the provider as the same stream', async () => {
  const provider = recordingProvider();
  const stream = Readable.from([Buffer.from('a'), Buffer.from('b')]);
  await normalizeAsset(stream, provider);
  expect(provider.calls[0]?.input).toBe(stream);
});

test('a stream from another stream library — pipe() plus async iteration — is staged too', async () => {
  const provider = recordingProvider();
  const lookalike = Object.assign(Object.create(null) as object, {
    pipe: () => undefined,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('x');
    },
  });
  await normalizeAsset(lookalike as unknown as Readable, provider);
  expect(provider.calls[0]?.input).toBe(lookalike);
});

test('a string naming an existing file is staged as that path', async () => {
  const provider = recordingProvider();
  await normalizeAsset(file, provider);
  expect(provider.calls[0]?.input).toBe(file);
});

test('a file: URL, as a URL or as a string, is staged as the path it names', async () => {
  const provider = recordingProvider();
  await normalizeAsset(pathToFileURL(file), provider);
  await normalizeAsset(pathToFileURL(file).href, provider);
  expect(provider.calls.map((call) => call.input)).toEqual([file, file]);
});

test('key, contentType and expiresIn are passed to stageRead, and an absent one is left out', async () => {
  const provider = recordingProvider();
  await normalizeAsset(Buffer.from('x'), provider, {
    key: 'logo.png',
    contentType: 'image/png',
    expiresIn: 600,
  });
  await normalizeAsset(Buffer.from('x'), provider, { key: 'b.png', contentType: undefined });
  expect(provider.calls.map((call) => call.opts)).toEqual([
    { key: 'logo.png', contentType: 'image/png', expiresIn: 600 },
    { key: 'b.png' },
  ]);
});

// --- what is refused ---------------------------------------------------------------------

test('a string that is neither an http(s) URL nor an existing file rejects invalid_argument saying so', async () => {
  const provider = recordingProvider();
  const error = await rejection(normalizeAsset('./no-such-capsule.mogrt', provider));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toBe(
    'The input "./no-such-capsule.mogrt" is neither an http(s) URL nor an existing file.',
  );
  expect(provider.calls).toEqual([]);
});

test('a directory is not a file: it rejects invalid_argument', async () => {
  const error = await rejection(normalizeAsset(dir, recordingProvider()));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('neither an http(s) URL nor an existing file');
});

test('a malformed http URL is neither a URL nor a file', async () => {
  const error = await rejection(normalizeAsset('https://', recordingProvider()));
  expect(error.message).toContain('neither an http(s) URL nor an existing file');
});

test('an input that needs staging with no provider rejects invalid_argument naming the storage option', async () => {
  for (const input of [Buffer.from('x'), Readable.from(['x']), file, pathToFileURL(file)]) {
    const error = await rejection(normalizeAsset(input));
    expect(error.code).toBe('invalid_argument');
    expect(error.message).toContain('no storage is configured');
    expect(error.message).toContain('storage option of configure() or createClient()');
  }
});

test('an empty string, a URL of another scheme, and a value of any other kind reject invalid_argument', async () => {
  const provider = recordingProvider();
  const empty = await rejection(normalizeAsset('', provider));
  expect(empty.message).toContain('empty string');
  const ftp = await rejection(normalizeAsset(new URL('ftp://files.example/a.png'), provider));
  expect(ftp.message).toContain('ftp: URL');
  for (const value of [42, null, undefined, { url: SIGNED }, [SIGNED]]) {
    const error = await rejection(normalizeAsset(value as unknown as StageInput, provider));
    expect(error.code).toBe('invalid_argument');
    expect(error.message).toContain('Expected an http(s) URL');
  }
  expect(provider.calls).toEqual([]);
});

test('a URL of another scheme is named with the article its sound takes', async () => {
  const provider = recordingProvider();
  const cases: Array<[string, string]> = [
    ['ftp://files.example/a.png', 'an ftp:'],
    ['sftp://files.example/a.png', 'an sftp:'],
    ['s3://bucket/a.png', 'an s3:'],
    ['ws://example.com/socket', 'a ws:'],
    ['data:text/plain,x', 'a data:'],
    ['blob:https://example.com/0f3c', 'a blob:'],
    ['about:blank', 'an about:'],
    ['mailto:someone@example.com', 'a mailto:'],
  ];
  for (const [url, named] of cases) {
    const error = await rejection(normalizeAsset(new URL(url), provider));
    expect(error.message).toBe(
      `The input is ${named} URL: DGR reads http(s) URLs, and a file: URL names a local file to upload.`,
    );
  }
  expect(provider.calls).toEqual([]);
});

test('a file: URL naming no existing file rejects invalid_argument', async () => {
  const missing = pathToFileURL(join(dir, 'missing.png'));
  const error = await rejection(normalizeAsset(missing, recordingProvider()));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('names no existing file');
});

test('a quoted input is cut short, so a huge string never balloons the message', async () => {
  const error = await rejection(normalizeAsset('x'.repeat(10_000), recordingProvider()));
  expect(error.message.length).toBeLessThan(200);
});

test('a signed-looking input that is not a URL keeps its signature out of every printed form', async () => {
  const typo = 'htps://acct.blob.core.windows.net/c/b.png?sv=2021&sp=r&sig=TYPO_SIG_VALUE';
  const error = await rejection(normalizeAsset(typo, recordingProvider()));
  expect(error.code).toBe('invalid_argument');
  const printed = [error.message, String(error), JSON.stringify(error), inspect(error)].join('\n');
  expect(printed).not.toContain('TYPO_SIG_VALUE');
  expect(printed).toContain('acct.blob.core.windows.net');
});

// --- provider failures -----------------------------------------------------------------

test('a provider that throws rejects storage_failed with its error as cause; its own AudioVideoError passes through', async () => {
  const cause = new Error('bucket unreachable');
  const failing = await rejection(
    normalizeAsset(Buffer.from('x'), {
      stageRead: () => Promise.reject(cause),
      allocateOutput: () => Promise.reject(cause),
    }),
  );
  expect(failing.code).toBe('storage_failed');
  expect(failing.cause).toBe(cause);

  const own = new AudioVideoError({ message: 'quota exceeded', code: 'quota' });
  const passed = await rejection(
    normalizeAsset(Buffer.from('x'), {
      stageRead: () => Promise.reject(own),
      allocateOutput: () => Promise.reject(own),
    }),
  );
  expect(passed).toBe(own);
});

test('a provider that resolves without a URL rejects storage_failed', async () => {
  for (const answer of ['', undefined, 42]) {
    const error = await rejection(
      normalizeAsset(Buffer.from('x'), {
        stageRead: async () => answer as unknown as string,
        allocateOutput: async () => ({ writeUrl: 'w', readUrl: 'r' }),
      }),
    );
    expect(error.code).toBe('storage_failed');
    expect(error.message).toContain('without a URL');
  }
});

// --- PassthroughStorageProvider -----------------------------------------------------------

test('PassthroughStorageProvider returns an http(s) URL as it is and refuses to upload anything', async () => {
  const passthrough = new PassthroughStorageProvider();
  await expect(passthrough.stageRead(SIGNED)).resolves.toBe(SIGNED);
  await expect(passthrough.stageRead(new URL(SIGNED))).resolves.toBe(new URL(SIGNED).href);
  for (const input of [Buffer.from('x'), Readable.from(['x']), file, pathToFileURL(file)]) {
    const error = await rejection(passthrough.stageRead(input));
    expect(error.code).toBe('invalid_argument');
    expect(error.message).toContain('does not upload');
  }
});

test('PassthroughStorageProvider cannot allocate an output', async () => {
  const error = await rejection(new PassthroughStorageProvider().allocateOutput());
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('give each output a destination');
});

test('normalizeAsset with a PassthroughStorageProvider passes a URL and refuses bytes with its invalid_argument', async () => {
  const passthrough = new PassthroughStorageProvider();
  await expect(normalizeAsset(SIGNED, passthrough)).resolves.toBe(SIGNED);
  const error = await rejection(normalizeAsset(Buffer.from('x'), passthrough));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('PassthroughStorageProvider does not upload');
});
