import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { AudioVideoError } from '../src/core/errors.js';
import { Asset, resolveAsset } from '../src/core/asset.js';
import type { ResolveAs } from '../src/core/asset.js';
import type { JobMeta } from '../src/core/job.js';

const SAS_URL =
  'https://x.blob.core.windows.net/out.mov?sv=2021&sig=SUPER_SECRET&se=2026&rest=keep';

const tempDirs: string[] = [];
const unhandledRejections: unknown[] = [];

function onUnhandledRejection(reason: unknown): void {
  unhandledRejections.push(reason);
}

beforeAll(() => {
  process.on('unhandledRejection', onUnhandledRejection);
});

afterAll(() => {
  process.off('unhandledRejection', onUnhandledRejection);
});

afterEach(() => {
  // Any unhandled rejection raised by a test — most importantly a fetch
  // failure that leaked past Readable.from's error handling — fails it here
  // rather than only printing a warning after the run.
  const seen = unhandledRejections.splice(0);
  expect(seen).toEqual([]);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory under the OS temp dir, removed after the test. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'firefly-audio-video-asset-'));
  tempDirs.push(dir);
  return dir;
}

/** Minimal, valid `JobMeta` — this file exercises `Asset`, not timing derivation. */
function sampleMeta(): JobMeta {
  return { jobId: 'job-1', perItem: [] };
}

/** A `Response` over a string, byte array, or web `ReadableStream` body. */
function fakeResponse(
  body: string | Uint8Array | ReadableStream<Uint8Array>,
  status = 200,
): Response {
  return new Response(body, { status });
}

/** A `ReadableStream` that enqueues each of `chunks` synchronously, then closes. */
function multiChunkBody(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** A writable that records each written chunk as its own `Buffer`. */
function captureChunks(): { stream: Writable; chunks: Buffer[] } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return { stream, chunks };
}

// --- buffer() ----------------------------------------------------------------------

test('buffer() returns the exact bytes', async () => {
  const asset = new Asset({
    url: 'https://x/out.mov',
    meta: sampleMeta(),
    fetch: async () => fakeResponse('hello world'),
  });

  expect((await asset.buffer()).equals(Buffer.from('hello world'))).toBe(true);
});

test('a non-2xx response makes buffer() throw a redacted AudioVideoError', async () => {
  const asset = new Asset({
    url: SAS_URL,
    meta: sampleMeta(),
    fetch: async () => fakeResponse('forbidden', 403),
  });

  const err: unknown = await asset.buffer().catch((e: unknown) => e);

  expect(err).toBeInstanceOf(AudioVideoError);
  const e = err as AudioVideoError;
  expect(e.code).toBe('asset_fetch_failed');
  expect(e.status).toBe(403);
  expect(e.message).not.toContain('SUPER_SECRET');
  expect(e.message).not.toContain('sig=');
});

// --- stream() ------------------------------------------------------------------------

test('stream() piped to a writable yields the exact concatenated bytes', async () => {
  const chunks = [Buffer.from('abc'), Buffer.from('defgh'), Buffer.from('ij')];
  const asset = new Asset({
    url: 'https://x/out.mov',
    meta: sampleMeta(),
    fetch: async () => fakeResponse(multiChunkBody(chunks)),
  });

  const sink = captureChunks();
  await pipeline(asset.stream(), sink.stream);

  expect(Buffer.concat(sink.chunks).equals(Buffer.concat(chunks))).toBe(true);
});

test('stream() is lazy — no fetch is issued until the stream is read', async () => {
  let fetchCalls = 0;
  const asset = new Asset({
    url: 'https://x/out.mov',
    meta: sampleMeta(),
    fetch: async () => {
      fetchCalls += 1;
      return fakeResponse('data');
    },
  });

  const stream = asset.stream();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fetchCalls).toBe(0);

  const sink = captureChunks();
  await pipeline(stream, sink.stream);
  expect(fetchCalls).toBe(1);
});

test('a fetch rejection on stream() surfaces as a stream error event, not an unhandled rejection', async () => {
  const asset = new Asset({
    url: 'https://x/out.mov',
    meta: sampleMeta(),
    fetch: async () => {
      throw new Error('network down');
    },
  });

  const stream = asset.stream();
  const errorEvent = new Promise<Error>((resolve) => {
    stream.once('error', (err: Error) => resolve(err));
  });
  stream.resume();

  const err = await errorEvent;
  expect(err.message).toBe('network down');
});

test('a non-2xx response on stream() surfaces as a redacted stream error event', async () => {
  const asset = new Asset({
    url: SAS_URL,
    meta: sampleMeta(),
    fetch: async () => fakeResponse('forbidden', 403),
  });

  const stream = asset.stream();
  const errorEvent = new Promise<AudioVideoError>((resolve) => {
    stream.once('error', (err: AudioVideoError) => resolve(err));
  });
  stream.resume();

  const err = await errorEvent;
  expect(err).toBeInstanceOf(AudioVideoError);
  expect(err.code).toBe('asset_fetch_failed');
  expect(err.status).toBe(403);
  expect(err.message).not.toContain('SUPER_SECRET');
});

// --- save() --------------------------------------------------------------------------

test('save() writes a file whose bytes match, creating the parent directory', async () => {
  const bytes = Buffer.from([1, 2, 3, 4, 5]);
  const asset = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: async () => fakeResponse(bytes),
  });

  const dir = tempDir();
  const path = join(dir, 'nested', 'sub', 'out.bin');
  expect(existsSync(join(dir, 'nested'))).toBe(false);

  await asset.save(path);

  expect(existsSync(join(dir, 'nested', 'sub'))).toBe(true);
  expect(readFileSync(path).equals(bytes)).toBe(true);
});

test('save() streams incrementally rather than buffering the whole body before writing', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const asset = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: async () => fakeResponse(body),
  });

  const dir = tempDir();
  const path = join(dir, 'out.bin');
  const savePromise = asset.save(path);

  const firstChunk = Buffer.from('first-chunk-');
  controller.enqueue(firstChunk);

  // The source is still open — a save() that buffered the whole response
  // first could not have written anything yet. Poll briefly rather than a
  // single fixed delay, so the assertion is not a race against the pipeline.
  const deadline = Date.now() + 2_000;
  while (!existsSync(path) || readFileSync(path).length === 0) {
    if (Date.now() > deadline)
      throw new Error('timed out waiting for the first chunk to reach disk');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(readFileSync(path).equals(firstChunk)).toBe(true);

  const secondChunk = Buffer.from('second-chunk');
  controller.enqueue(secondChunk);
  controller.close();
  await savePromise;

  expect(readFileSync(path).equals(Buffer.concat([firstChunk, secondChunk]))).toBe(true);
});

test('a non-2xx response makes save() reject with the same AudioVideoError, having written nothing', async () => {
  const asset = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: async () => fakeResponse('forbidden', 403),
  });

  const dir = tempDir();
  const path = join(dir, 'out.bin');

  await expect(asset.save(path)).rejects.toMatchObject({ code: 'asset_fetch_failed' });
  // node:fs creates (and would truncate) the destination file as soon as
  // pipeline() opens it, before the source ever produces a byte — so the file
  // exists, but it is empty: nothing was written before the failure.
  expect(readFileSync(path).length).toBe(0);
});

// --- redaction on toJSON / toString / util.inspect ------------------------------------

test('toJSON()/toString()/util.inspect redact the URL while .url itself still carries it', () => {
  const asset = new Asset({ url: SAS_URL, meta: sampleMeta() });

  expect(asset.url).toContain('sig=SUPER_SECRET');

  const serialized = [JSON.stringify(asset), asset.toString(), inspect(asset)];
  for (const s of serialized) {
    expect(s).not.toContain('SUPER_SECRET');
    expect(s).not.toContain('sig=');
    expect(s).toContain('rest=keep');
  }
});

test('toJSON() reports the meta alongside the redacted url', () => {
  const meta = sampleMeta();
  const asset = new Asset({ url: SAS_URL, meta });

  expect(asset.toJSON()).toEqual({
    url: 'https://x.blob.core.windows.net/out.mov?rest=keep',
    meta,
  });
});

// --- resolveAsset ----------------------------------------------------------------------

test('resolveAsset(asset) with no mode returns the Asset itself', async () => {
  const asset = new Asset({ url: 'https://x/out.mov', meta: sampleMeta() });
  await expect(resolveAsset(asset)).resolves.toBe(asset);
});

test("resolveAsset(asset, 'url') returns the raw url", async () => {
  const asset = new Asset({ url: SAS_URL, meta: sampleMeta() });
  await expect(resolveAsset(asset, 'url')).resolves.toBe(SAS_URL);
});

test("resolveAsset(asset, 'buffer') returns the asset's bytes", async () => {
  const asset = new Asset({
    url: 'https://x/out.mov',
    meta: sampleMeta(),
    fetch: async () => fakeResponse('payload'),
  });
  const result = await resolveAsset(asset, 'buffer');
  expect(Buffer.isBuffer(result)).toBe(true);
  expect((result as Buffer).equals(Buffer.from('payload'))).toBe(true);
});

test("resolveAsset(asset, 'stream') returns a Readable over the asset's bytes", async () => {
  const asset = new Asset({
    url: 'https://x/out.mov',
    meta: sampleMeta(),
    fetch: async () => fakeResponse('payload'),
  });
  const result = await resolveAsset(asset, 'stream');
  const sink = captureChunks();
  await pipeline(result as import('node:stream').Readable, sink.stream);
  expect(Buffer.concat(sink.chunks).toString()).toBe('payload');
});

test("resolveAsset(asset, 'file', path) saves and returns the path", async () => {
  const asset = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: async () => fakeResponse('payload'),
  });
  const dir = tempDir();
  const path = join(dir, 'out.bin');

  await expect(resolveAsset(asset, 'file', path)).resolves.toBe(path);
  expect(readFileSync(path, 'utf8')).toBe('payload');
});

test("resolveAsset(asset, 'file') without a savePath throws a clear invalid_argument error", async () => {
  const asset = new Asset({ url: 'https://x/out.mov', meta: sampleMeta() });
  await expect(resolveAsset(asset, 'file')).rejects.toMatchObject({
    code: 'invalid_argument',
  });
});

test('resolveAsset rejects an unrecognized resolveAs with invalid_argument', async () => {
  const asset = new Asset({ url: 'https://x/out.mov', meta: sampleMeta() });
  await expect(resolveAsset(asset, 'bogus' as unknown as ResolveAs)).rejects.toMatchObject({
    code: 'invalid_argument',
  });
});
