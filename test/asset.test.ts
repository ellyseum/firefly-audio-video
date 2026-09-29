import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { Console } from 'node:console';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';
import { inspect } from 'node:util';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { AudioVideoError } from '../src/core/errors.js';
import { Asset, resolveAsset } from '../src/core/asset.js';
import type { ResolveAs } from '../src/core/asset.js';
import type { JobMeta } from '../src/core/job.js';

const SAS_URL =
  'https://x.blob.core.windows.net/out.mov?sv=2021&sig=SUPER_SECRET&se=2026&rest=keep';

/** Bytes outside the ASCII range, so a payload cannot survive a lossy UTF-8 round trip unnoticed. */
const NON_ASCII_BYTES = Buffer.from([0xff, 0xfe, 0x80, 0x00, 0x01, 0xc0, 0xff, 0x7f]);

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
