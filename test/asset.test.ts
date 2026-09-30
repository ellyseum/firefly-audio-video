import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { Console } from 'node:console';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';
import { inspect } from 'node:util';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { AudioVideoError } from '../src/core/errors.js';
import { Asset, resolveAsset } from '../src/core/asset.js';
import type { AssetReadOptions, ResolveAs } from '../src/core/asset.js';
import type { JobMeta } from '../src/core/job.js';
import { flush, until } from './support/mock-api.js';
import {
  payload,
  sha256,
  startRangeServer,
  type RangeServer,
  type RangeServerOptions,
  type Resource,
  type SeenRequest,
} from './support/range-server.js';

const SAS_URL =
  'https://x.blob.core.windows.net/out.mov?sv=2021&sig=SUPER_SECRET&se=2026&rest=keep';

/** Bytes outside the ASCII range, so a payload cannot survive a lossy UTF-8 round trip unnoticed. */
const NON_ASCII_BYTES = Buffer.from([0xff, 0xfe, 0x80, 0x00, 0x01, 0xc0, 0xff, 0x7f]);

const tempDirs: string[] = [];
const servers: RangeServer[] = [];
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

beforeEach(() => {
  // Every retry's jittered backoff draws a fraction from Math.random; zero
  // makes each wait 0 ms, so a test that resumes spends no real time waiting.
  // The backoff schedule itself has its own test, and a test that needs a
  // real wait draws its own fraction.
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await server.close();
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

/** `JobMeta` carrying every timing field, so a copy that drops any of them is detectable. */
function fullMeta(): JobMeta {
  return {
    jobId: 'job-42',
    createdAt: 1_700_000_000_000,
    queueMs: 120,
    renderMs: 4_500,
    totalMs: 4_620,
    perItem: [
      { index: 0, queueMs: 60, renderMs: 2_000, totalMs: 2_060 },
      { index: 1, queueMs: 60, renderMs: 2_500, totalMs: 2_560 },
    ],
  };
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

/** A `ReadableStream` that enqueues each of `chunks`, then errors instead of closing — a mid-download reset. */
function resettingBody(chunks: readonly Uint8Array[], error: Error): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.error(error);
    },
  });
}

/** A `ReadableStream` that never closes on its own, for enqueuing chunks and aborting mid-read in a test. */
function controllableBody(): {
  body: ReadableStream<Uint8Array>;
  controller: ReadableStreamDefaultController<Uint8Array>;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return { body, controller };
}

/** The single `*.partial` temp file `save()` is currently writing beside `destPath`, if any. */
function findTempFile(dir: string, destBaseName: string): string | undefined {
  return readdirSync(dir).find(
    (name) => name.startsWith(`${destBaseName}.`) && name.endsWith('.partial'),
  );
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

/** `console.table(value)`'s rendered output, captured via a private `Console` instance. */
function captureConsoleTable(value: unknown): string {
  const chunks: string[] = [];
  const capture = new Console({
    stdout: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString('utf8'));
        callback();
      },
    }),
  });
  capture.table(value);
  return chunks.join('');
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

test('buffer() preserves non-ASCII bytes exactly, with no lossy text round trip', async () => {
  const asset = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: async () => fakeResponse(NON_ASCII_BYTES),
  });

  expect((await asset.buffer()).equals(NON_ASCII_BYTES)).toBe(true);
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

test('stream() preserves non-ASCII bytes exactly, with no lossy text round trip', async () => {
  const asset = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: async () => fakeResponse(NON_ASCII_BYTES),
  });

  const sink = captureChunks();
  await pipeline(asset.stream(), sink.stream);

  expect(Buffer.concat(sink.chunks).equals(NON_ASCII_BYTES)).toBe(true);
});

test('stream() is a byte stream, not object mode — read(n) returns exactly n bytes', async () => {
  const chunks = [Buffer.from('abcdefgh'), Buffer.from('ijkl')];
  const asset = new Asset({
    url: 'https://x/out.mov',
    meta: sampleMeta(),
    fetch: async () => fakeResponse(multiChunkBody(chunks)),
  });

  const stream = asset.stream();
  expect(stream.readableObjectMode).toBe(false);

  // Let both chunks land in the internal buffer before reading, so read(4)
  // is exercised against real buffered bytes rather than a race with delivery.
  await new Promise<void>((resolve) => stream.once('readable', resolve));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const read = stream.read(4) as Buffer;
  expect(read.length).toBe(4);
  expect(read.equals(Buffer.from('abcd'))).toBe(true);

  const sink = captureChunks();
  await pipeline(stream, sink.stream);
  expect(Buffer.concat(sink.chunks).toString('utf8')).toBe('efghijkl');
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

test('a fetch rejection on stream() surfaces as a wrapped asset_fetch_failed error event, not an unhandled rejection', async () => {
  const asset = new Asset({
    url: 'https://x/out.mov',
    meta: sampleMeta(),
    fetch: async () => {
      throw new Error('network down');
    },
  });

  const stream = asset.stream();
  const errorEvent = new Promise<AudioVideoError>((resolve) => {
    stream.once('error', (err: AudioVideoError) => resolve(err));
  });
  stream.resume();

  const err = await errorEvent;
  expect(err).toBeInstanceOf(AudioVideoError);
  expect(err.code).toBe('asset_fetch_failed');
  expect((err.cause as Error).message).toBe('network down');
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

test('save() preserves non-ASCII bytes exactly, with no lossy text round trip', async () => {
  const asset = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: async () => fakeResponse(NON_ASCII_BYTES),
  });

  const dir = tempDir();
  const path = join(dir, 'out.bin');

  await asset.save(path);

  expect(readFileSync(path).equals(NON_ASCII_BYTES)).toBe(true);
});

test('save() streams incrementally to its temp file rather than buffering the whole body before writing', async () => {
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
  // first could not have written anything yet, to the temp file or anywhere
  // else. Poll briefly rather than a single fixed delay, so the assertion is
  // not a race against the pipeline.
  const deadline = Date.now() + 2_000;
  let tempName: string | undefined;
  for (;;) {
    tempName = findTempFile(dir, 'out.bin');
    if (tempName !== undefined && readFileSync(join(dir, tempName)).length > 0) break;
    if (Date.now() > deadline)
      throw new Error('timed out waiting for the first chunk to reach disk');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(readFileSync(join(dir, tempName)).equals(firstChunk)).toBe(true);
  // The destination itself gets nothing until the whole download completes.
  expect(existsSync(path)).toBe(false);

  const secondChunk = Buffer.from('second-chunk');
  controller.enqueue(secondChunk);
  controller.close();
  await savePromise;

  expect(readFileSync(path).equals(Buffer.concat([firstChunk, secondChunk]))).toBe(true);
  expect(readdirSync(dir)).toEqual(['out.bin']);
});

test('a non-2xx response makes save() reject with the same AudioVideoError, leaving the destination absent', async () => {
  const asset = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: async () => fakeResponse('forbidden', 403),
  });

  const dir = tempDir();
  const path = join(dir, 'out.bin');

  await expect(asset.save(path)).rejects.toMatchObject({ code: 'asset_fetch_failed' });
  expect(existsSync(path)).toBe(false);
  expect(readdirSync(dir)).toEqual([]);
});

test('a non-2xx response onto an existing destination leaves it byte-identical, with no temp file left behind', async () => {
  const asset = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: async () => fakeResponse('forbidden', 403),
  });

  const dir = tempDir();
  const path = join(dir, 'out.bin');
  const original = Buffer.from('already here, do not touch');
  writeFileSync(path, original);

  await expect(asset.save(path)).rejects.toMatchObject({ code: 'asset_fetch_failed' });
  expect(readFileSync(path).equals(original)).toBe(true);
  expect(readdirSync(dir)).toEqual(['out.bin']);
});

test('a mid-download reset leaves an absent destination absent, with no temp file left behind', async () => {
  const asset = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: async () =>
      fakeResponse(resettingBody([Buffer.from('partial-bytes')], new Error('reset'))),
  });

  const dir = tempDir();
  const path = join(dir, 'out.bin');

  await expect(asset.save(path)).rejects.toThrow();
  expect(existsSync(path)).toBe(false);
  expect(readdirSync(dir)).toEqual([]);
});

test('a mid-download reset leaves an existing destination byte-identical, with no temp file left behind', async () => {
  const asset = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: async () =>
      fakeResponse(resettingBody([Buffer.from('partial-bytes')], new Error('reset'))),
  });

  const dir = tempDir();
  const path = join(dir, 'out.bin');
  const original = Buffer.from('already here, do not touch');
  writeFileSync(path, original);

  await expect(asset.save(path)).rejects.toThrow();
  expect(readFileSync(path).equals(original)).toBe(true);
  expect(readdirSync(dir)).toEqual(['out.bin']);
});

test('save() replaces an existing destination with the new bytes on success', async () => {
  const bytes = Buffer.from('brand new bytes');
  const asset = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: async () => fakeResponse(bytes),
  });

  const dir = tempDir();
  const path = join(dir, 'out.bin');
  writeFileSync(path, Buffer.from('stale'));

  await asset.save(path);

  expect(readFileSync(path).equals(bytes)).toBe(true);
  expect(readdirSync(dir)).toEqual(['out.bin']);
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

test('the url is never an own enumerable property, so a printer that bypasses toJSON/inspect cannot expose it', () => {
  const asset = new Asset({ url: SAS_URL, meta: sampleMeta() });

  expect(asset.url).toContain('sig=SUPER_SECRET');

  expect(Object.keys(asset)).toEqual(['meta']);
  expect('url' in { ...asset }).toBe(false);
  expect('url' in Object.assign({}, asset)).toBe(false);
  expect('url' in structuredClone(asset)).toBe(false);
  expect(inspect(asset, { customInspect: false })).not.toContain('SUPER_SECRET');
  expect(captureConsoleTable(asset)).not.toContain('SUPER_SECRET');
});

test('toJSON() reports the meta alongside the redacted url', () => {
  const meta = sampleMeta();
  const asset = new Asset({ url: SAS_URL, meta });

  expect(asset.toJSON()).toEqual({
    url: 'https://x.blob.core.windows.net/out.mov?rest=keep',
    meta,
  });
});

test('toString() is exactly JSON.stringify(asset.toJSON())', () => {
  const asset = new Asset({ url: SAS_URL, meta: sampleMeta() });

  expect(asset.toString()).toBe(JSON.stringify(asset.toJSON()));
});

test('util.inspect output carries meta alongside the redacted url', () => {
  const meta = sampleMeta();
  const asset = new Asset({ url: SAS_URL, meta });

  expect(inspect(asset)).toContain(`jobId: '${meta.jobId}'`);
});

test('a meta with every timing field round-trips losslessly through the asset', () => {
  const meta = fullMeta();
  const asset = new Asset({ url: 'https://x/out.mov', meta });

  expect(asset.meta).toEqual(meta);
  expect(asset.toJSON().meta).toEqual(meta);
});

// --- transport failures wrap as asset_fetch_failed, cause included -------------------

const MALFORMED_URL = 'https://[invalid/out.mov?sig=SUPER_SECRET';

/** Every printable surface a caller might reach an AudioVideoError, or its cause, through. */
function printedSurfaces(err: AudioVideoError): string[] {
  return [
    err.message,
    String(err),
    inspect(err, { depth: null }),
    JSON.stringify(err),
    String(err.cause),
    inspect(err.cause, { depth: null }),
  ];
}

test('a malformed URL makes buffer() reject asset_fetch_failed, with the secret absent from every printable surface including the cause', async () => {
  const asset = new Asset({ url: MALFORMED_URL, meta: sampleMeta() });

  const err = (await asset.buffer().catch((e: unknown) => e)) as AudioVideoError;

  expect(err).toBeInstanceOf(AudioVideoError);
  expect(err.code).toBe('asset_fetch_failed');
  for (const s of printedSurfaces(err)) {
    expect(s).not.toContain('SUPER_SECRET');
  }
});

test('a malformed URL makes save() reject asset_fetch_failed, with the secret absent from every printable surface including the cause', async () => {
  const asset = new Asset({ url: MALFORMED_URL, meta: sampleMeta() });
  const dir = tempDir();
  const path = join(dir, 'out.bin');

  const err = (await asset.save(path).catch((e: unknown) => e)) as AudioVideoError;

  expect(err).toBeInstanceOf(AudioVideoError);
  expect(err.code).toBe('asset_fetch_failed');
  for (const s of printedSurfaces(err)) {
    expect(s).not.toContain('SUPER_SECRET');
  }
  expect(existsSync(path)).toBe(false);
});

test('a malformed URL makes stream() emit asset_fetch_failed, with the secret absent from every printable surface including the cause', async () => {
  const asset = new Asset({ url: MALFORMED_URL, meta: sampleMeta() });

  const stream = asset.stream();
  const errorEvent = new Promise<AudioVideoError>((resolve) => {
    stream.once('error', (err: AudioVideoError) => resolve(err));
  });
  stream.resume();

  const err = await errorEvent;
  expect(err).toBeInstanceOf(AudioVideoError);
  expect(err.code).toBe('asset_fetch_failed');
  for (const s of printedSurfaces(err)) {
    expect(s).not.toContain('SUPER_SECRET');
  }
});

// --- cancellation via AbortSignal ------------------------------------------------------

test('a pre-aborted signal makes buffer() reject cancelled without calling fetch', async () => {
  let fetchCalls = 0;
  const asset = new Asset({
    url: 'https://x/out.mov',
    meta: sampleMeta(),
    fetch: async () => {
      fetchCalls += 1;
      return fakeResponse('data');
    },
  });
  const controller = new AbortController();
  controller.abort(new Error('pre-aborted'));

  const err = await asset.buffer({ signal: controller.signal }).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(AudioVideoError);
  expect((err as AudioVideoError).code).toBe('cancelled');
  expect(fetchCalls).toBe(0);
});

test('a pre-aborted signal makes stream() emit cancelled without calling fetch', async () => {
  let fetchCalls = 0;
  const asset = new Asset({
    url: 'https://x/out.mov',
    meta: sampleMeta(),
    fetch: async () => {
      fetchCalls += 1;
      return fakeResponse('data');
    },
  });
  const controller = new AbortController();
  controller.abort(new Error('pre-aborted'));

  const stream = asset.stream({ signal: controller.signal });
  const errorEvent = new Promise<AudioVideoError>((resolve) => {
    stream.once('error', (err: AudioVideoError) => resolve(err));
  });
  stream.resume();

  const err = await errorEvent;
  expect(err).toBeInstanceOf(AudioVideoError);
  expect(err.code).toBe('cancelled');
  expect(fetchCalls).toBe(0);
});

test('a pre-aborted signal makes save() reject cancelled without calling fetch, leaving the destination absent', async () => {
  let fetchCalls = 0;
  const asset = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: async () => {
      fetchCalls += 1;
      return fakeResponse('data');
    },
  });
  const controller = new AbortController();
  controller.abort(new Error('pre-aborted'));
  const dir = tempDir();
  const path = join(dir, 'out.bin');

  const err = await asset.save(path, { signal: controller.signal }).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(AudioVideoError);
  expect((err as AudioVideoError).code).toBe('cancelled');
  expect(fetchCalls).toBe(0);
  expect(existsSync(path)).toBe(false);
  expect(readdirSync(dir)).toEqual([]);
});

test('an abort mid-download makes buffer() reject cancelled', async () => {
  const { body, controller } = controllableBody();
  const asset = new Asset({
    url: 'https://x/out.mov',
    meta: sampleMeta(),
    fetch: async () => fakeResponse(body),
  });
  const ac = new AbortController();

  const bufferPromise = asset.buffer({ signal: ac.signal });
  controller.enqueue(Buffer.from('partial'));
  setTimeout(() => ac.abort(new Error('mid-download abort')), 20);

  const err = await bufferPromise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AudioVideoError);
  expect((err as AudioVideoError).code).toBe('cancelled');
});

test('an abort mid-download makes stream() emit cancelled', async () => {
  const { body, controller } = controllableBody();
  const asset = new Asset({
    url: 'https://x/out.mov',
    meta: sampleMeta(),
    fetch: async () => fakeResponse(body),
  });
  const ac = new AbortController();

  const stream = asset.stream({ signal: ac.signal });
  const errorEvent = new Promise<AudioVideoError>((resolve) => {
    stream.once('error', (err: AudioVideoError) => resolve(err));
  });
  stream.resume();
  controller.enqueue(Buffer.from('partial'));
  setTimeout(() => ac.abort(new Error('mid-download abort')), 20);

  const err = await errorEvent;
  expect(err).toBeInstanceOf(AudioVideoError);
  expect(err.code).toBe('cancelled');
});

test('an abort mid-download makes save() reject cancelled, leaving the destination absent with no temp file left behind', async () => {
  const { body, controller } = controllableBody();
  const asset = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: async () => fakeResponse(body),
  });
  const ac = new AbortController();
  const dir = tempDir();
  const path = join(dir, 'out.bin');

  const savePromise = asset.save(path, { signal: ac.signal });
  controller.enqueue(Buffer.from('partial'));
  setTimeout(() => ac.abort(new Error('mid-download abort')), 20);

  const err = await savePromise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AudioVideoError);
  expect((err as AudioVideoError).code).toBe('cancelled');
  expect(existsSync(path)).toBe(false);
  expect(readdirSync(dir)).toEqual([]);
});

test('a non-2xx response cancels the unread body before rejecting, releasing the connection', async () => {
  let cancelCalls = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from('forbidden body'));
      // Deliberately never closes: if this response's body were drained
      // rather than cancelled, awaiting it here would hang.
    },
    cancel() {
      cancelCalls += 1;
    },
  });
  const asset = new Asset({
    url: 'https://x/out.mov',
    meta: sampleMeta(),
    fetch: async () => fakeResponse(body, 403),
  });

  const err = await asset.buffer().catch((e: unknown) => e);

  expect(err).toBeInstanceOf(AudioVideoError);
  expect((err as AudioVideoError).code).toBe('asset_fetch_failed');
  expect(cancelCalls).toBe(1);
});

test('the signal reaches the underlying fetch call, so an abort while the fetch itself is still pending is honoured', async () => {
  const asset = new Asset({
    url: 'https://x/out.mov',
    meta: sampleMeta(),
    fetch: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined) {
          reject(new Error('fetch was called without a signal'));
          return;
        }
        // Never settles on its own — only reacting to the signal, so this
        // proves the signal genuinely reached the fetch call rather than
        // stopping at some earlier point.
        signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
      }),
  });
  const controller = new AbortController();

  const bufferPromise = asset.buffer({ signal: controller.signal });
  setTimeout(() => controller.abort(new Error('abort while fetch is pending')), 20);

  const err = await bufferPromise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AudioVideoError);
  expect((err as AudioVideoError).code).toBe('cancelled');
});

// --- the default fetch (globalThis.fetch) path --------------------------------------

test('an Asset with no fetch override drives the real default fetch, via an undici MockAgent', async () => {
  const originalDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  try {
    mockAgent
      .get('https://asset-default-fetch.example')
      .intercept({ path: '/out.mov', method: 'GET' })
      .reply(200, 'payload');

    const asset = new Asset({
      url: 'https://asset-default-fetch.example/out.mov',
      meta: sampleMeta(),
    });

    const result = await asset.buffer();
    expect(result.equals(Buffer.from('payload'))).toBe(true);
  } finally {
    await mockAgent.close();
    setGlobalDispatcher(originalDispatcher);
  }
});

// --- resolveAsset ----------------------------------------------------------------------

test('resolveAsset(asset) with no mode returns the Asset itself', async () => {
  const asset = new Asset({ url: 'https://x/out.mov', meta: sampleMeta() });
  await expect(resolveAsset(asset)).resolves.toBe(asset);
});

test("resolveAsset(asset, { resolveAs: 'url' }) returns the raw url", async () => {
  const asset = new Asset({ url: SAS_URL, meta: sampleMeta() });
  await expect(resolveAsset(asset, { resolveAs: 'url' })).resolves.toBe(SAS_URL);
});

test("resolveAsset(asset, { resolveAs: 'buffer' }) returns the asset's bytes", async () => {
  const asset = new Asset({
    url: 'https://x/out.mov',
    meta: sampleMeta(),
    fetch: async () => fakeResponse('payload'),
  });
  const result = await resolveAsset(asset, { resolveAs: 'buffer' });
  expect(Buffer.isBuffer(result)).toBe(true);
  expect((result as Buffer).equals(Buffer.from('payload'))).toBe(true);
});

test("resolveAsset(asset, { resolveAs: 'stream' }) returns a Readable over the asset's bytes", async () => {
  const asset = new Asset({
    url: 'https://x/out.mov',
    meta: sampleMeta(),
    fetch: async () => fakeResponse('payload'),
  });
  const result = await resolveAsset(asset, { resolveAs: 'stream' });
  const sink = captureChunks();
  await pipeline(result as import('node:stream').Readable, sink.stream);
  expect(Buffer.concat(sink.chunks).toString()).toBe('payload');
});

test("resolveAsset(asset, { resolveAs: 'stream' }) resolves immediately with a lazy stream, not one buffered from the whole body first", async () => {
  const { body, controller } = controllableBody();
  let fetchCalls = 0;
  const asset = new Asset({
    url: 'https://x/out.mov',
    meta: sampleMeta(),
    fetch: async () => {
      fetchCalls += 1;
      return fakeResponse(body);
    },
  });

  const TIMED_OUT = Symbol('timed out');
  let timer!: ReturnType<typeof setTimeout>;
  // asset.stream() returns synchronously without touching the network, so
  // resolveAsset() should settle almost immediately here. If it instead
  // buffered the body first (via asset.buffer()), this race would time out:
  // the body below is never closed until after the race is decided.
  const result = await Promise.race([
    resolveAsset(asset, { resolveAs: 'stream' }),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), 100);
    }),
  ]);
  clearTimeout(timer);

  expect(result).not.toBe(TIMED_OUT);
  expect(fetchCalls).toBe(0);

  const chunk = Buffer.from('payload');
  controller.enqueue(chunk);
  controller.close();

  const sink = captureChunks();
  await pipeline(result as Readable, sink.stream);
  expect(Buffer.concat(sink.chunks).equals(chunk)).toBe(true);
  expect(fetchCalls).toBe(1);
});

test("resolveAsset(asset, { resolveAs: 'file', savePath }) saves and returns the path", async () => {
  const asset = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: async () => fakeResponse('payload'),
  });
  const dir = tempDir();
  const path = join(dir, 'out.bin');

  await expect(resolveAsset(asset, { resolveAs: 'file', savePath: path })).resolves.toBe(path);
  expect(readFileSync(path, 'utf8')).toBe('payload');
});

test("resolveAsset(asset, { resolveAs: 'file' }) without a savePath throws a clear invalid_argument error", async () => {
  const asset = new Asset({ url: 'https://x/out.mov', meta: sampleMeta() });
  await expect(resolveAsset(asset, { resolveAs: 'file' })).rejects.toMatchObject({
    code: 'invalid_argument',
  });
});

test('resolveAsset rejects an unrecognized resolveAs with invalid_argument', async () => {
  const asset = new Asset({ url: 'https://x/out.mov', meta: sampleMeta() });
  await expect(
    resolveAsset(asset, { resolveAs: 'bogus' as unknown as ResolveAs }),
  ).rejects.toMatchObject({
    code: 'invalid_argument',
  });
});

test("resolveAsset(asset, { resolveAs: 'buffer', signal }) forwards the signal to buffer()", async () => {
  const asset = new Asset({
    url: 'https://x/out.mov',
    meta: sampleMeta(),
    fetch: async () => fakeResponse('payload'),
  });
  const controller = new AbortController();
  controller.abort(new Error('pre-aborted'));

  const err = await resolveAsset(asset, { resolveAs: 'buffer', signal: controller.signal }).catch(
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AudioVideoError);
  expect((err as AudioVideoError).code).toBe('cancelled');
});

// --- resumable downloads, over a real HTTP server on 127.0.0.1 ------------------------

/** 256 KiB of non-repeating bytes, so a spliced or shifted download cannot match by accident. */
const BODY = payload(262_144);
/** Where the first response of most tests below is cut off. */
const CUT = 100_000;
const V1: Resource = { body: BODY, etag: '"v1"' };
/** A different version of the asset, as if it were replaced between two requests. */
const V2: Resource = { body: payload(200_000, 2), etag: '"v2"' };
const LAST_MODIFIED = 'Tue, 29 Sep 2026 12:00:00 GMT';

type Accessor = 'stream' | 'save' | 'buffer';

/** Starts a range server that is closed after the test. */
async function rangeServer(options: RangeServerOptions): Promise<RangeServer> {
  const server = await startRangeServer(options);
  servers.push(server);
  return server;
}

/** A range server that cuts only its first response, after `CUT` bytes, and handles the rest as `then` says. */
function cutOnce(
  resource: RangeServerOptions['resource'],
  then: RangeServerOptions['handle'] = () => ({}),
): Promise<RangeServer> {
  return rangeServer({ resource, handle: (i) => (i === 0 ? { cutAfter: CUT } : then(i)) });
}

/**
 * The offset a request's `Range: bytes=<offset>-` asks for, or `NaN` for any
 * other header. A body that fails discards what its reader had fetched ahead
 * but not yet delivered, so a resumption asks for the bytes delivered — at
 * most the bytes the server sent before the cut, never more.
 */
function rangeOffset(range: string | undefined): number {
  const match = range === undefined ? null : /^bytes=(\d+)-$/.exec(range);
  return match === null ? Number.NaN : Number(match[1]);
}

/** Checks `request` resumed a download the server cut after `sent` bytes: a `Range` from within them, and the expected `If-Range`. */
function expectResumption(
  request: SeenRequest | undefined,
  sent: number,
  ifRange: string | undefined,
): void {
  const offset = rangeOffset(request?.range);
  expect(offset, `resumed from byte ${offset}`).toBeGreaterThan(0);
  expect(offset, `resumed from byte ${offset}`).toBeLessThanOrEqual(sent);
  expect(request?.ifRange).toBe(ifRange);
}

/** The bytes `accessor` produces from `asset`; for `save`, read back from a fresh directory holding nothing else. */
async function readThrough(
  asset: Asset,
  accessor: Accessor,
  options: AssetReadOptions = {},
): Promise<Buffer> {
  if (accessor === 'buffer') return asset.buffer(options);
  if (accessor === 'stream') {
    const sink = captureChunks();
    await pipeline(asset.stream(options), sink.stream);
    return Buffer.concat(sink.chunks);
  }
  const dir = tempDir();
  const path = join(dir, 'out.bin');
  await asset.save(path, options);
  expect(readdirSync(dir)).toEqual(['out.bin']);
  return readFileSync(path);
}

/** The error `accessor` fails with; for `save`, also checks that nothing was left on disk. */
async function readFailure(
  asset: Asset,
  accessor: Accessor,
  options: AssetReadOptions = {},
): Promise<AudioVideoError> {
  let failure: Promise<unknown>;
  const dir = tempDir();
  if (accessor === 'buffer') failure = asset.buffer(options);
  else if (accessor === 'stream') failure = pipeline(asset.stream(options), captureChunks().stream);
  else failure = asset.save(join(dir, 'out.bin'), options);
  const err = await failure.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AudioVideoError);
  expect(readdirSync(dir)).toEqual([]);
  for (const surface of printedSurfaces(err as AudioVideoError)) {
    expect(surface).not.toContain('RANGE_SERVER_SECRET');
  }
  return err as AudioVideoError;
}

/** Resolves once `predicate()` holds, polling every few milliseconds of real time. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test.each<Accessor>(['stream', 'save', 'buffer'])(
  '%s() resumes a download cut mid-body with Range and If-Range, and the bytes match exactly',
  async (accessor) => {
    const server = await cutOnce(V1);
    const asset = new Asset({ url: server.url, meta: sampleMeta() });

    const bytes = await readThrough(asset, accessor);

    expect(sha256(bytes)).toBe(sha256(BODY));
    expect(server.cuts()).toBe(1);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]).toEqual({ range: undefined, ifRange: undefined });
    expectResumption(server.requests[1], CUT, '"v1"');
  },
);

test('a download cut twice resumes twice, each time from where it stopped', async () => {
  const server = await rangeServer({
    resource: V1,
    handle: (i) => (i === 0 ? { cutAfter: 60_000 } : i === 1 ? { cutAfter: 50_000 } : {}),
  });
  const asset = new Asset({ url: server.url, meta: sampleMeta() });

  const bytes = await asset.buffer();

  expect(sha256(bytes)).toBe(sha256(BODY));
  expect(server.requests).toHaveLength(3);
  expectResumption(server.requests[1], 60_000, '"v1"');
  const first = rangeOffset(server.requests[1]?.range);
  const second = rangeOffset(server.requests[2]?.range);
  expect(second).toBeGreaterThan(first);
  expect(second).toBeLessThanOrEqual(first + 50_000);
  expect(server.requests[2]?.ifRange).toBe('"v1"');
});

test.each<Accessor>(['stream', 'save', 'buffer'])(
  '%s({ retries: 0 }) fails at the first cut, re-requesting nothing',
  async (accessor) => {
    const server = await rangeServer({ resource: V1, handle: () => ({ cutAfter: CUT }) });
    const asset = new Asset({ url: server.url, meta: sampleMeta() });

    const err = await readFailure(asset, accessor, { retries: 0 });

    expect(err.code).toBe('asset_fetch_failed');
    expect(err.message).toMatch(/^Fetching the asset at .* failed\.$/);
    expect(err.cause).toBeInstanceOf(Error);
    expect(server.requests).toHaveLength(1);
  },
);

test.each([
  [undefined, 4, '3 retries'],
  [1, 2, '1 retry'],
])(
  'a server that keeps cutting the body fails the download once the retries run out (retries: %s → %i requests)',
  async (retries, requests, spent) => {
    // Each response is cut after 10,000 of its bytes, until the fifth, which
    // would be served whole: a download that ignored its budget would succeed.
    const server = await rangeServer({
      resource: V1,
      handle: (i) => (i < 4 ? { cutAfter: 10_000 } : {}),
    });
    const asset = new Asset({ url: server.url, meta: sampleMeta() });

    const err = await readFailure(asset, 'buffer', retries === undefined ? {} : { retries });

    expect(err.code).toBe('asset_fetch_failed');
    expect(err.message).toContain(`and ${spent} did not complete it.`);
    expect(err.cause).toBeInstanceOf(Error);
    expect(server.requests).toHaveLength(requests);
    for (const request of server.requests.slice(1)) {
      expect(request.range).toMatch(/^bytes=\d+-$/);
    }
  },
);

test('a server that answers the Range request with 200: save() starts over from byte zero and still produces the exact bytes', async () => {
  const server = await cutOnce(V1, () => ({ ignoreRange: true }));
  const asset = new Asset({ url: server.url, meta: sampleMeta() });

  // readThrough also checks the partial temp file from before the restart is gone.
  const bytes = await readThrough(asset, 'save');

  expect(sha256(bytes)).toBe(sha256(BODY));
  // The 200's own body is the fresh start: there is no third request.
  expect(server.requests).toHaveLength(2);
  expectResumption(server.requests[1], CUT, '"v1"');
});

test.each<Accessor>(['stream', 'buffer'])(
  'a server that answers the Range request with 200: %s() rejects saying the download could not be resumed',
  async (accessor) => {
    const server = await cutOnce(V1, () => ({ ignoreRange: true }));
    const asset = new Asset({ url: server.url, meta: sampleMeta() });

    const err = await readFailure(asset, accessor);

    expect(err.code).toBe('asset_fetch_failed');
    const offset = rangeOffset(server.requests[1]?.range);
    expect(err.message).toContain(`interrupted after ${offset} bytes and could not be resumed`);
    expect(err.message).toContain('the server answered 200');
    expect(err.status).toBeUndefined();
    expect(server.requests).toHaveLength(2);
  },
);

test('stream() never repeats the bytes it already emitted when the server answers the Range request with 200', async () => {
  const server = await cutOnce(V1, () => ({ ignoreRange: true }));
  const asset = new Asset({ url: server.url, meta: sampleMeta() });

  const sink = captureChunks();
  const err = await pipeline(asset.stream(), sink.stream).then(
    () => undefined,
    (e: unknown) => e,
  );

  expect(err).toMatchObject({ code: 'asset_fetch_failed' });
  const emitted = Buffer.concat(sink.chunks);
  expect(emitted.length).toBeLessThanOrEqual(CUT);
  expect(emitted.equals(BODY.subarray(0, emitted.length))).toBe(true);
});

test.each([
  [
    'starts before the offset',
    (start: number, length: number) => `bytes ${start - 10}-${length - 1}/${length}`,
  ],
  [
    'starts after the offset',
    (start: number, length: number) => `bytes ${start + 10}-${length - 1}/${length}`,
  ],
  [
    'gives a different total length',
    (start: number, length: number) => `bytes ${start}-${length - 1}/${length + 1}`,
  ],
  ['is not a byte range at all', (_start: number, length: number) => `bytes */${length}`],
])('a 206 whose Content-Range %s is refused: stream() rejects', async (_case, contentRange) => {
  const server = await cutOnce(V1, () => ({ contentRange }));
  const asset = new Asset({ url: server.url, meta: sampleMeta() });

  const err = await readFailure(asset, 'stream');

  expect(err.code).toBe('asset_fetch_failed');
  expect(err.message).toContain('could not be resumed');
  expect(err.message).toContain("the server's Content-Range");
  expect(server.requests).toHaveLength(2);
});

test('a 206 whose Content-Range does not continue at the offset makes save() start over with a plain request', async () => {
  const server = await cutOnce(V1, (i) =>
    i === 1
      ? { contentRange: (start, length) => `bytes ${start - 10}-${length - 1}/${length}` }
      : {},
  );
  const asset = new Asset({ url: server.url, meta: sampleMeta() });

  const bytes = await readThrough(asset, 'save');

  expect(sha256(bytes)).toBe(sha256(BODY));
  expect(server.requests).toHaveLength(3);
  expectResumption(server.requests[1], CUT, '"v1"');
  expect(server.requests[2]).toEqual({ range: undefined, ifRange: undefined });
});

test('an asset replaced between attempts: If-Range brings the new version whole, and save() keeps exactly that', async () => {
  const server = await cutOnce((i) => (i === 0 ? V1 : V2));
  const asset = new Asset({ url: server.url, meta: sampleMeta() });

  const bytes = await readThrough(asset, 'save');

  expect(sha256(bytes)).toBe(sha256(V2.body));
  expect(server.requests).toHaveLength(2);
  expectResumption(server.requests[1], CUT, '"v1"');
});

test.each<Accessor>(['stream', 'buffer'])(
  'an asset replaced between attempts makes %s() reject rather than splice two versions',
  async (accessor) => {
    const server = await cutOnce((i) => (i === 0 ? V1 : V2));
    const asset = new Asset({ url: server.url, meta: sampleMeta() });

    const err = await readFailure(asset, accessor);

    expect(err.message).toContain('could not be resumed');
    expectResumption(server.requests[1], CUT, '"v1"');
  },
);

test('a 206 whose ETag no longer matches is refused, even from a server that ignored If-Range', async () => {
  const server = await cutOnce(V1, () => ({ etag: '"v2"' }));
  const asset = new Asset({ url: server.url, meta: sampleMeta() });

  const err = await readFailure(asset, 'stream');

  expect(err.message).toContain('could not be resumed, because the asset changed');
  expect(err.message).toContain('ETag');
});

test('a 416 on the resumption: stream() rejects with its status, save() starts over with a plain request', async () => {
  const refusing = await cutOnce(V1, () => ({ status: 416 }));
  const err = await readFailure(new Asset({ url: refusing.url, meta: sampleMeta() }), 'stream');
  expect(err.message).toContain('416 Range Not Satisfiable');
  expect(err.status).toBe(416);

  const restarting = await cutOnce(V1, (i) => (i === 1 ? { status: 416 } : {}));
  const bytes = await readThrough(new Asset({ url: restarting.url, meta: sampleMeta() }), 'save');
  expect(sha256(bytes)).toBe(sha256(BODY));
  expect(restarting.requests).toHaveLength(3);
  expectResumption(restarting.requests[1], CUT, '"v1"');
  expect(restarting.requests[2]).toEqual({ range: undefined, ifRange: undefined });
});

test('a 403 on the resumption fails the download at once, with retries still unspent', async () => {
  const server = await cutOnce(V1, () => ({ status: 403 }));
  const asset = new Asset({ url: server.url, meta: sampleMeta() });

  const err = await readFailure(asset, 'buffer');

  expect(err.code).toBe('asset_fetch_failed');
  expect(err.status).toBe(403);
  expect(err.message).toMatch(/failed with status 403 after the download was interrupted\.$/);
  expect(server.requests).toHaveLength(2);
});

test.each([408, 429, 503])(
  'a %i on the resumption is retried, and the next attempt continues the download',
  async (status) => {
    const server = await cutOnce(V1, (i) => (i === 1 ? { status } : {}));
    const asset = new Asset({ url: server.url, meta: sampleMeta() });

    const bytes = await asset.buffer();

    expect(sha256(bytes)).toBe(sha256(BODY));
    expect(server.requests).toHaveLength(3);
    expectResumption(server.requests[1], CUT, '"v1"');
    expect(server.requests[2]).toEqual(server.requests[1]);
  },
);

test.each([
  ['a weak ETag, which If-Range may not carry', { etag: 'W/"weak"', lastModified: LAST_MODIFIED }],
  ['no ETag', { lastModified: LAST_MODIFIED }],
])('with %s, If-Range carries the Last-Modified date instead', async (_case, validators) => {
  const server = await cutOnce({ body: BODY, ...validators });
  const asset = new Asset({ url: server.url, meta: sampleMeta() });

  const bytes = await asset.buffer();

  expect(sha256(bytes)).toBe(sha256(BODY));
  expectResumption(server.requests[1], CUT, LAST_MODIFIED);
});

test('with no validator at all, the resumption asks for the range unconditionally', async () => {
  const server = await cutOnce({ body: BODY });
  const asset = new Asset({ url: server.url, meta: sampleMeta() });

  const bytes = await asset.buffer();

  expect(sha256(bytes)).toBe(sha256(BODY));
  expectResumption(server.requests[1], CUT, undefined);
});

test('an abort during the backoff makes save() reject cancelled, sending no further request and leaving no temp file', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0.999); // the first retry waits just under 250 ms
  const server = await rangeServer({ resource: V1, handle: () => ({ cutAfter: CUT }) });
  const asset = new Asset({ url: server.url, meta: sampleMeta() });
  const controller = new AbortController();
  const dir = tempDir();

  const saving = asset.save(join(dir, 'out.bin'), { signal: controller.signal });
  await waitFor(() => server.cuts() === 1);
  // Long enough for the client to see the cut and start its backoff, and
  // well short of the backoff itself.
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort(new Error('stop the download'));
  const err = await saving.catch((e: unknown) => e);

  expect(err).toBeInstanceOf(AudioVideoError);
  expect((err as AudioVideoError).code).toBe('cancelled');
  expect(server.requests).toHaveLength(1);
  expect(readdirSync(dir)).toEqual([]);
  expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
});

test("no abort listener is left on the caller's signal, whether the download resumed or could not", async () => {
  const controller = new AbortController();

  const resuming = await cutOnce(V1);
  await new Asset({ url: resuming.url, meta: sampleMeta() }).buffer({ signal: controller.signal });
  expect(getEventListeners(controller.signal, 'abort')).toEqual([]);

  const refusing = await cutOnce(V1, () => ({ ignoreRange: true }));
  await readFailure(new Asset({ url: refusing.url, meta: sampleMeta() }), 'stream', {
    signal: controller.signal,
  });
  expect(getEventListeners(controller.signal, 'abort')).toEqual([]);

  const exhausted = await rangeServer({ resource: V1, handle: () => ({ cutAfter: 10_000 }) });
  await readFailure(new Asset({ url: exhausted.url, meta: sampleMeta() }), 'save', {
    signal: controller.signal,
  });
  expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
});

test('every response a failed download received is read or cancelled, and its connection closed', async () => {
  // A 503 to the first resumption, then a 200: neither body is wanted.
  const server = await rangeServer({
    resource: V1,
    handle: (i) =>
      i === 0 ? { cutAfter: CUT } : i === 1 ? { status: 503 } : { ignoreRange: true },
  });
  const responses: Response[] = [];
  const asset = new Asset({
    url: server.url,
    meta: sampleMeta(),
    fetch: async (url, init) => {
      const res = await globalThis.fetch(url, init);
      responses.push(res);
      return res;
    },
  });

  const err = await readFailure(asset, 'buffer');

  expect(err.message).toContain('could not be resumed');
  expect(responses.map((res) => res.status)).toEqual([200, 503, 200]);
  // bodyUsed is true once a body has been read or cancelled, never for one left untouched.
  expect(responses.map((res) => res.bodyUsed)).toEqual([true, true, true]);
  await server.idle();
});

// --- resumable downloads, through a stubbed fetch -----------------------------------------

test('a body that ends cleanly but short of its Content-Length resumes like a cut', async () => {
  const requests: Array<Record<string, string>> = [];
  const asset = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: async (_url, init) => {
      requests.push(init?.headers ?? {});
      if (requests.length === 1) {
        return new Response(BODY.subarray(0, 1_000), {
          headers: { 'content-length': String(BODY.length), etag: '"v1"' },
        });
      }
      return new Response(BODY.subarray(1_000), {
        status: 206,
        headers: { 'content-range': `bytes 1000-${BODY.length - 1}/${BODY.length}`, etag: '"v1"' },
      });
    },
  });

  const bytes = await asset.buffer();

  expect(sha256(bytes)).toBe(sha256(BODY));
  expect(requests).toEqual([{}, { Range: 'bytes=1000-', 'If-Range': '"v1"' }]);
});

/**
 * A fetch stub whose first response is a content-encoded body that is cut off
 * only once its first chunk has been delivered — `delivered()` fires the cut
 * — and whose later responses carry the whole of `BODY`. Records each
 * request's headers.
 */
function contentEncodedThenWhole(): {
  fetch: (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;
  requests: Array<Record<string, string>>;
  cut: () => void;
} {
  const requests: Array<Record<string, string>> = [];
  const { body, controller } = controllableBody();
  controller.enqueue(Buffer.from('decoded bytes'));
  return {
    requests,
    cut: () => controller.error(new Error('reset')),
    fetch: async (_url, init) => {
      requests.push(init?.headers ?? {});
      return requests.length === 1
        ? new Response(body, { headers: { 'content-encoding': 'gzip', etag: '"v1"' } })
        : fakeResponse(BODY);
    },
  };
}

test('a content-encoded body is never resumed by byte offset: stream() rejects without re-requesting', async () => {
  const stub = contentEncodedThenWhole();
  const stream = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: stub.fetch,
  }).stream();
  const failed = new Promise<unknown>((resolve) => stream.once('error', resolve));
  stream.once('data', () => stub.cut());
  stream.resume();

  const err = (await failed) as AudioVideoError;

  expect(err).toBeInstanceOf(AudioVideoError);
  expect(err.code).toBe('asset_fetch_failed');
  expect(err.message).toContain('could not be resumed');
  expect(err.message).toContain('content-encoded');
  expect(stub.requests).toEqual([{}]);
});

test('a content-encoded body is never resumed by byte offset: save() starts over with a plain request', async () => {
  const stub = contentEncodedThenWhole();
  const dir = tempDir();
  const path = join(dir, 'out.bin');
  const saving = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: stub.fetch,
  }).save(path);
  // Cut the body once its first chunk has reached the temp file.
  await waitFor(() => {
    const name = findTempFile(dir, 'out.bin');
    return name !== undefined && readFileSync(join(dir, name)).length > 0;
  });
  stub.cut();
  await saving;

  expect(sha256(readFileSync(path))).toBe(sha256(BODY));
  expect(readdirSync(dir)).toEqual(['out.bin']);
  expect(stub.requests).toEqual([{}, {}]);
});

test('each retry first waits a uniform fraction of a doubling delay, capped at 2 s before the fraction is taken', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const random = vi.spyOn(Math, 'random');
  for (const fraction of [0.5, 0.5, 0.5, 0.5, 0.999]) random.mockReturnValueOnce(fraction);
  let requests = 0;
  const asset = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: async () => {
      requests += 1;
      return requests === 1
        ? fakeResponse(resettingBody([Buffer.from('partial')], new Error('reset')))
        : fakeResponse('busy', 503);
    },
  });

  const reading = asset.buffer({ retries: 5 }).catch((e: unknown) => e);

  // min(2 s, 250 ms × 2^(retry − 1)) × the fraction drawn for that retry.
  for (const delayMs of [125, 250, 500, 1_000, 1_998]) {
    await until(() => vi.getTimerCount() === 1);
    const before = requests;
    await vi.advanceTimersByTimeAsync(delayMs - 1);
    await flush();
    expect(requests, `no request before ${delayMs} ms`).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => requests === before + 1);
  }
  const err = await reading;
  expect(err).toMatchObject({ code: 'asset_fetch_failed', status: 503 });
  expect((err as AudioVideoError).message).toContain('and 5 retries did not complete it.');
});

test('an abort during the backoff ends the wait at once, clearing its timer and every listener it added', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(Math, 'random').mockReturnValue(0.5); // a 125 ms backoff, which the fake clock never reaches
  let requests = 0;
  const asset = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: async () => {
      requests += 1;
      return fakeResponse(resettingBody([Buffer.from('partial')], new Error('reset')));
    },
  });
  const controller = new AbortController();
  let settled = false;
  const reading = asset
    .buffer({ signal: controller.signal })
    .catch((e: unknown) => e)
    .finally(() => {
      settled = true;
    });

  await until(() => vi.getTimerCount() === 1);
  controller.abort(new Error('stop the download'));
  await until(() => settled);
  const err = await reading;

  expect(err).toBeInstanceOf(AudioVideoError);
  expect((err as AudioVideoError).code).toBe('cancelled');
  expect(vi.getTimerCount()).toBe(0);
  expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  expect(requests).toBe(1);
});

test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3'])(
  'retries: %s is refused with invalid_argument before any request',
  async (retries) => {
    let requests = 0;
    const asset = new Asset({
      url: 'https://x/out.bin',
      meta: sampleMeta(),
      fetch: async () => {
        requests += 1;
        return fakeResponse('data');
      },
    });
    const options = { retries } as unknown as AssetReadOptions;

    await expect(asset.buffer(options)).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(asset.save(join(tempDir(), 'out.bin'), options)).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    let thrown: unknown;
    try {
      asset.stream(options);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ code: 'invalid_argument' });
    expect(requests).toBe(0);
  },
);

test('a fetch that ignores its signal and resolves after an abort still ends the read cancelled', async () => {
  const controller = new AbortController();
  const asset = new Asset({
    url: 'https://x/out.bin',
    meta: sampleMeta(),
    fetch: async () => {
      controller.abort(new Error('aborted while the fetch was pending'));
      return fakeResponse('bytes that must not be returned');
    },
  });

  const err = await asset.buffer({ signal: controller.signal }).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(AudioVideoError);
  expect((err as AudioVideoError).code).toBe('cancelled');
});
