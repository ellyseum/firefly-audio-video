import { getEventListeners, once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, expect, expectTypeOf, test } from 'vitest';
import { Asset } from '../src/core/asset.js';
import { AudioVideoError } from '../src/core/errors.js';
import { InMemoryPool } from '../src/core/pool.js';
import type { JobHandle } from '../src/core/pooled-job.js';
import { createRenderBuilder, type RenderBuilder } from '../src/dgr/builder.js';
import { createClient, type Client, type ClientConfig } from '../src/dgr/client.js';
import { Preset } from '../src/dgr/preset.js';
import {
  MockApi,
  STORAGE,
  eventually,
  fakeStorage,
  flush,
  recordingLogger,
  running,
  succeeded,
  trickle,
  until,
  wireOutput,
  type FakeStorage,
} from './support/mock-api.js';

const CAPSULE = `${STORAGE}/capsule.mogrt?sv=2021&sp=r&sig=CAPSULE_SIG`;
const BYTES = Buffer.from([0x00, 0x66, 0xff, 0x80, 0x7f]);

let api: MockApi;
let storage: FakeStorage;
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
  storage = fakeStorage();
});

afterEach(async () => {
  await api.close();
  expect(unhandledRejections.splice(0)).toEqual([]);
});

function client(extra: Partial<ClientConfig> = {}): Client {
  return createClient({
    clientId: 'client-id',
    clientSecret: 'secret',
    logging: false,
    storage,
    ...extra,
  });
}

/** Jobs that each succeed on their first poll, with one output. */
function jobsSucceed(...jobIds: string[]): void {
  api.submit(jobIds);
  for (const jobId of jobIds) api.status(jobId, () => succeeded(jobId, [wireOutput(0, 0, 3, 9)]));
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

/** Runs `body` with `AbortSignal.any` missing, as on Node before 18.17 and 20.3. */
async function withoutAbortSignalAny(body: () => Promise<void>): Promise<void> {
  const native = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
  Object.defineProperty(AbortSignal, 'any', {
    value: undefined,
    configurable: true,
    writable: true,
  });
  try {
    await body();
  } finally {
    if (native !== undefined) Object.defineProperty(AbortSignal, 'any', native);
  }
}

test('a fluent render resolves an Asset through allocateOutput: the write URL goes to DGR, the read URL becomes asset.url', async () => {
  jobsSucceed('job-1');
  const builder = client().render(CAPSULE, { pollIntervalMs: 0 }).h264Land1080pHq;
  expectTypeOf(builder).toEqualTypeOf<RenderBuilder>();
  expectTypeOf<Awaited<typeof builder>>().toEqualTypeOf<Asset>();

  const asset = await builder;

  expect(asset).toBeInstanceOf(Asset);
  expect(storage.allocations).toHaveLength(1);
  expect(asset.url).toBe(storage.allocations[0]?.readUrl);
  expect(asset.meta).toMatchObject({ jobId: 'job-1', queueMs: 3_000, totalMs: 9_000 });
  expect(api.submitted()).toEqual([
    {
      source: { url: CAPSULE },
      presets: [{ source: { presetId: 'ffs_video_api_land_1080p_hq' } }],
      variations: [{ variables: [] }],
      outputs: [
        {
          variationIndex: 0,
          presetIndex: 0,
          destination: { url: storage.allocations[0]?.writeUrl },
        },
      ],
    },
  ]);
  expect(builder.jobId).toBe('job-1');
  expect(builder.meta?.totalMs).toBe(9_000);
});

test('a fluent render without storage rejects invalid_argument explaining the option and the explicit-destination form', async () => {
  const error = await rejection(
    createClient({ clientId: 'id', clientSecret: 'secret', logging: false }).render(CAPSULE).prores,
  );
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('storage option');
  expect(error.message).toContain('destination');
  expect(api.calls).toEqual([]);
});

test('a fluent render with no preset chosen rejects invalid_argument naming preset names', async () => {
  const error = await rejection(client().render(CAPSULE));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('.prores');
  expect(error.message).toContain('h264Land1080pHq');
  expect(api.calls).toEqual([]);
  expect(storage.allocations).toEqual([]);
});

test('the builder proxies the Preset chain: a config the chain produces is staged as a generated .epr', async () => {
  jobsSucceed('job-1');
  await client().render(CAPSULE, { pollIntervalMs: 0 }).hevc1080p10bit.bitrate('40M');

  expect(storage.staged).toHaveLength(1);
  expect((storage.staged[0]?.input as Buffer).toString('utf8')).toContain('<PremiereData');
  expect(api.submitted()[0]?.presets).toEqual([
    { source: { url: expect.stringContaining('/staged/1.epr') } },
  ]);
});

test('a chain that lands on a native preset submits that presetId and stages nothing', async () => {
  jobsSucceed('job-1');
  await client().render(CAPSULE, { pollIntervalMs: 0 }).h264Land1080pHq.resize('9:16');
  expect(storage.staged).toEqual([]);
  expect(api.submitted()[0]?.presets).toEqual([
    { source: { presetId: 'ffs_video_api_vert_1920p_hq' } },
  ]);
});

test('every step returns a new builder and leaves the one it came from unchanged', () => {
  const base = client().render(CAPSULE);
  const prores = base.prores;
  const hevc = base.hevc1080p10bit.alpha(false);
  expect(prores).not.toBe(base);
  expect(hevc).not.toBe(prores);
  expect(inspect(base)).toBe(inspect({ jobId: undefined, preset: undefined }));
  expect(inspect(prores)).toContain("name: 'prores'");
  expect(inspect(hevc)).toContain("codec: 'hevc'");
});

test('a presigned .epr URL passed as { preset } never appears in inspect, even before the render starts', () => {
  const signedEpr = `${STORAGE}/custom.epr?sv=2021&sp=r&sig=EPR_SIG`;
  const builder = client().render(CAPSULE, { preset: signedEpr });
  expect(inspect(builder)).not.toContain('sig=');
  expect(inspect(builder)).not.toContain('EPR_SIG');
  expect(inspect(builder)).toContain("kind: 'epr'");
});

test('building submits nothing; awaiting starts one render that every consumer shares', async () => {
  jobsSucceed('job-1', 'job-2');
  const builder = client().render(CAPSULE, { pollIntervalMs: 0 }).prores;
  for (let turn = 0; turn < 5; turn += 1) await flush();
  expect(api.calls).toEqual([]);

  const [first, second] = await Promise.all([builder, builder]);
  expect(first).toBe(second);
  expect(await builder).toBe(first);
  expect(api.count('POST', '/v1/templates/render')).toBe(1);
});

test('.buffer(), .save() and .stream() render, then read the finished asset', async () => {
  jobsSucceed('job-1', 'job-2', 'job-3');
  api.download('/out/', BYTES);
  const c = client();

  const buffered = c.render(CAPSULE, { pollIntervalMs: 0 }).prores.buffer();
  expectTypeOf(buffered).toEqualTypeOf<Promise<Buffer>>();
  expect(Buffer.compare(await buffered, BYTES)).toBe(0);

  const dir = mkdtempSync(join(tmpdir(), 'firefly-audio-video-builder-'));
  const path = join(dir, 'out.mov');
  const saved = c.render(CAPSULE, { pollIntervalMs: 0 }).prores.save(path);
  expectTypeOf(saved).toEqualTypeOf<Promise<void>>();
  await saved;
  expect(Buffer.compare(readFileSync(path), BYTES)).toBe(0);
  unlinkSync(path);
  rmdirSync(dir);

  const stream = c.render(CAPSULE, { pollIntervalMs: 0 }).prores.stream();
  expectTypeOf(stream).toEqualTypeOf<Readable>();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  expect(Buffer.compare(Buffer.concat(chunks), BYTES)).toBe(0);
  expect(api.count('POST', '/v1/templates/render')).toBe(3);
});

test('.buffer(), .save() and .stream() hand their retries option to the asset read, which validates it', async () => {
  jobsSucceed('job-retries-1', 'job-retries-2', 'job-retries-3');
  api.download('/out/', BYTES);
  const c = client();
  const dir = mkdtempSync(join(tmpdir(), 'firefly-audio-video-builder-'));
  const path = join(dir, 'out.mov');

  const buffered = await rejection(
    c.render(CAPSULE, { pollIntervalMs: 0 }).prores.buffer({ retries: -1 }),
  );
  const saved = await rejection(
    c.render(CAPSULE, { pollIntervalMs: 0 }).prores.save(path, { retries: -1 }),
  );
  const stream = c.render(CAPSULE, { pollIntervalMs: 0 }).prores.stream({ retries: -1 });
  const streamed = await rejection(
    (async () => {
      for await (const chunk of stream) void chunk;
    })(),
  );

  for (const error of [buffered, saved, streamed]) {
    expect(error.code).toBe('invalid_argument');
    expect(error.message).toContain('retries must be a non-negative integer');
  }
  expect(existsSync(path)).toBe(false);
  rmdirSync(dir);
});

test('finished .buffer() and .stream() reads leave no listener on the builder or read signals, on a Node without AbortSignal.any too', async () => {
  await withoutAbortSignalAny(async () => {
    jobsSucceed('job-listeners');
    api.download('/out/', BYTES);
    const signals = {
      builder: new AbortController().signal,
      buffer: new AbortController().signal,
      stream: new AbortController().signal,
    };
    const builder = client().render(CAPSULE, { pollIntervalMs: 0, signal: signals.builder }).prores;

    expect(Buffer.compare(await builder.buffer({ signal: signals.buffer }), BYTES)).toBe(0);
    const chunks: Buffer[] = [];
    for await (const chunk of builder.stream({ signal: signals.stream })) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.compare(Buffer.concat(chunks), BYTES)).toBe(0);

    for (const [name, signal] of Object.entries(signals)) {
      expect.soft(getEventListeners(signal, 'abort'), `${name} signal`).toHaveLength(0);
    }
  });
});

test('.save() creates its destination directory, the same as Asset.save', async () => {
  jobsSucceed('job-mkdir');
  api.download('/out/', BYTES);
  const dir = mkdtempSync(join(tmpdir(), 'firefly-audio-video-builder-'));
  const nested = join(dir, 'nested', 'deep', 'out.mov');

  await client().render(CAPSULE, { pollIntervalMs: 0 }).prores.save(nested);

  expect(Buffer.compare(readFileSync(nested), BYTES)).toBe(0);
  unlinkSync(nested);
  rmdirSync(join(dir, 'nested', 'deep'));
  rmdirSync(join(dir, 'nested'));
  rmdirSync(dir);
});

test('the builder signal cancels an in-progress .save(), writing nothing to disk, even after the render has settled', async () => {
  jobsSucceed('job-save-cancel');
  let started = false;
  api.downloadDelayed('/out/', BYTES, 200, () => {
    started = true;
  });
  const controller = new AbortController();
  const dir = mkdtempSync(join(tmpdir(), 'firefly-audio-video-builder-'));
  const path = join(dir, 'out.mov');

  const builder = client().render(CAPSULE, { pollIntervalMs: 0, signal: controller.signal }).prores;
  await builder;
  const saved = builder.save(path);
  await until(() => started);
  controller.abort();
  const error = await rejection(saved);
  expect(error.code).toBe('cancelled');
  expect(existsSync(path)).toBe(false);
  rmdirSync(dir);
});

test('cancel() after the builder has settled cancels an in-progress .buffer() read', async () => {
  jobsSucceed('job-buffer-cancel');
  let started = false;
  api.downloadDelayed('/out/', BYTES, 200, () => {
    started = true;
  });
  const builder = client().render(CAPSULE, { pollIntervalMs: 0 }).prores;
  await builder;
  const read = builder.buffer();
  await until(() => started);
  await builder.cancel();
  const error = await rejection(read);
  expect(error.code).toBe('cancelled');
});

test('a render failure surfaces on .stream() as an error event', async () => {
  const stream = createClient({ clientId: 'id', clientSecret: 'secret', logging: false })
    .render(CAPSULE)
    .prores.stream();
  const error = await rejection(
    (async () => {
      for await (const chunk of stream) void chunk;
    })(),
  );
  expect(error.code).toBe('invalid_argument');
});

test('a .stream() pipeline torn down while the render runs cancels the render on the service and downloads nothing', async () => {
  api.submit(['job-d']);
  let polls = 0;
  api.status('job-d', () => {
    polls += 1;
    return polls < 4 ? running('job-d') : succeeded('job-d', [wireOutput(0, 0, 1, 2)]);
  });
  api.cancel('job-d');
  api.download('/out/', BYTES);
  const builder = client().render(CAPSULE, { pollIntervalMs: 10 }).prores;
  const sink = new PassThrough();
  const piping = pipeline(builder.stream(), sink);
  await until(() => polls >= 1);

  sink.destroy(new Error('the client went away'));
  await expect(piping).rejects.toThrow('the client went away');
  await until(() => api.count('PUT', '/v1/cancel/job-d') === 1);
  expect((await rejection(builder)).code).toBe('cancelled');
  await sleep(100);
  expect(api.count('GET', '/out/', STORAGE)).toBe(0);
});

test('destroying a .stream() mid-download ends the download at once, before its next chunk', async () => {
  jobsSucceed('job-1');
  const download = trickle(`${STORAGE}/out/`, 10, 200);
  try {
    const stream = client().render(CAPSULE, { pollIntervalMs: 0 }).prores.stream();
    const closed = once(stream, 'close');
    stream.resume();
    await eventually(() => download.served() >= 2, 5_000);

    const servedAtStop = download.served();
    stream.destroy();
    await closed;
    // Longer than one chunk's interval: a download still running would have served another.
    await sleep(300);
    expect(download.served()).toBe(servedAtStop);
  } finally {
    download.restore();
  }
});

test('a destroyed .stream() closes at once even while the render it waits on has not settled', async () => {
  const never = new Promise<Asset>(() => undefined);
  const stuck: JobHandle<Asset> = {
    jobId: 'job-stuck',
    meta: undefined,
    cancel: () => Promise.resolve(),
    then: (onfulfilled, onrejected) => never.then(onfulfilled, onrejected),
    catch: (onrejected) => never.catch(onrejected),
    finally: (onfinally) => never.finally(onfinally),
  };
  const builder = createRenderBuilder(CAPSULE, {}, () => ({
    startFluentRender: () => stuck,
    logCancelled: () => undefined,
  }));
  const stream = builder.stream();
  stream.resume();
  await flush();

  stream.destroy();
  const outcome = await Promise.race([
    once(stream, 'close').then(() => 'closed'),
    sleep(1_000).then(() => 'still open'),
  ]);
  expect(outcome).toBe('closed');
});

test('destroying a .stream() before it is read cancels nothing: the builder still renders when awaited', async () => {
  jobsSucceed('job-1');
  const builder = client().render(CAPSULE, { pollIntervalMs: 0 }).prores;
  const stream = builder.stream();
  stream.destroy();
  await once(stream, 'close');

  expect(api.calls).toEqual([]);
  await expect(builder).resolves.toBeInstanceOf(Asset);
});

test('cancel() before the render starts makes it reject cancelled once awaited, submitting nothing', async () => {
  const builder = client().render(CAPSULE).prores;
  await builder.cancel();
  const error = await rejection(builder);
  expect(error.code).toBe('cancelled');
  expect(api.calls).toEqual([]);
  expect(storage.allocations).toEqual([]);
});

test('cancel() before the render starts logs one warn record on a builder bound to a client', async () => {
  const logger = recordingLogger();
  const bound = createClient({
    clientId: 'bound-id',
    clientSecret: 'secret',
    logging: logger,
    storage,
  });
  const builder = client().render(CAPSULE, { client: bound }).prores;
  await builder.cancel();
  await rejection(builder);
  await flush();
  expect(logger.records).toHaveLength(1);
  expect(logger.records[0]).toMatchObject({ level: 'warn', msg: 'render cancelled' });
});

test('cancel() before the render starts stays silent on an unbound builder, so it never creates the default client', async () => {
  const logger = recordingLogger();
  const builder = client({ logging: logger }).render(CAPSULE).prores;
  await builder.cancel();
  await rejection(builder);
  await flush();
  expect(logger.records).toEqual([]);
});

test('cancel() after the submit asks the service to stop the job', async () => {
  api.submit(['job-1']);
  api.status('job-1', () => running('job-1'));
  api.cancel('job-1');
  const builder = client().render(CAPSULE, { pollIntervalMs: 1 }).prores;
  const settled = rejection(builder);
  await until(() => builder.jobId === 'job-1');

  await builder.cancel();
  expect((await settled).code).toBe('cancelled');
  expect(api.count('PUT', '/v1/cancel/job-1')).toBe(1);
});

test('a signal aborted after a fluent render submits stops polling and cancels the job remotely', async () => {
  const controller = new AbortController();
  api.submit(['job-2']);
  api.status('job-2', () => running('job-2'));
  api.cancel('job-2');
  const builder = client().render(CAPSULE, { pollIntervalMs: 1, signal: controller.signal }).prores;
  const settled = rejection(builder);
  await until(() => builder.jobId === 'job-2');

  controller.abort();
  const error = await settled;
  expect(error.code).toBe('cancelled');
  expect(api.count('PUT', '/v1/cancel/job-2')).toBe(1);
});

test('an already-aborted signal makes the fluent render reject cancelled, submitting nothing', async () => {
  jobsSucceed('job-never');
  const controller = new AbortController();
  controller.abort();
  const error = await rejection(client().render(CAPSULE, { signal: controller.signal }).prores);
  expect(error.code).toBe('cancelled');
  expect(api.calls).toEqual([]);
});

test('a signal aborted while a fluent render is still queued for a pool slot submits nothing', async () => {
  const pool = new InMemoryPool({ concurrency: 1 });
  let open = false;
  api.submit(['holder', 'queued']);
  api.status('holder', () =>
    open ? succeeded('holder', [wireOutput(0, 0, 1, 2)]) : running('holder'),
  );
  const c = client({ pool });

  const holder = c.render(CAPSULE, { pollIntervalMs: 1 }).prores;
  void holder.catch(() => undefined); // starts the render now; its real outcome is awaited below
  await until(() => api.count('POST', '/v1/templates/render') === 1);

  const controller = new AbortController();
  const queued = c.render(CAPSULE, { pollIntervalMs: 1, signal: controller.signal }).prores;
  const settled = rejection(queued);
  await flush();
  expect(pool.queued).toBe(1);

  controller.abort();
  const error = await settled;
  expect(error.code).toBe('cancelled');

  open = true;
  await holder;
  expect(api.count('POST', '/v1/templates/render')).toBe(1);
});

test('the preset option starts the chain, fileName names the output, and a URL or { url } is a source', async () => {
  jobsSucceed('job-1', 'job-2', 'job-3');
  const c = client();

  await c.render(new URL(CAPSULE), { preset: 'prores', fileName: 'master.mov', pollIntervalMs: 0 });
  await c.render({ url: CAPSULE }, { preset: Preset.prores, pollIntervalMs: 0 }).alpha(false).with({
    codec: 'prores4444xq',
  });
  await c.render(CAPSULE, {
    preset: { codec: 'hevc', bitDepth: 10, resolution: '1920x1080' },
    pollIntervalMs: 0,
  });

  const [first, second, third] = api.submitted();
  expect(first).toMatchObject({
    source: { url: CAPSULE },
    presets: [{ source: { presetId: 'ffs_video_api_prores' } }],
    outputs: [{ fileName: 'master.mov' }],
  });
  expect(second).toMatchObject({ source: { url: CAPSULE } });
  expect(second?.presets).toEqual([{ source: { url: expect.stringContaining('/staged/') } }]);
  expect(third?.presets).toEqual([{ source: { url: expect.stringContaining('/staged/') } }]);
  expect(storage.staged).toHaveLength(2);
});

test('an invalid preset option rejects when the render starts, naming the preset', async () => {
  const error = await rejection(client().render(CAPSULE, { preset: 'not-a-preset' }));
  expect(error.code).toBe('invalid_preset');
  expect(error.message.startsWith('The preset: ')).toBe(true);
  expect(api.calls).toEqual([]);
});

test('a fluent render emits exactly one log record', async () => {
  const logger = recordingLogger();
  jobsSucceed('job-1');
  await client({ logging: logger }).render(CAPSULE, { pollIntervalMs: 0 }).hevc4k10bit;
  await flush();
  expect(logger.records).toHaveLength(1);
  expect(logger.records[0]).toMatchObject({
    msg: 'render completed',
    jobId: 'job-1',
    preset: 'hevc4k10bit',
    codec: 'hevc',
    resolution: '3840x2160',
    status: 'succeeded',
  });
  expect(JSON.stringify(logger.records[0])).not.toContain('sig=');
});
