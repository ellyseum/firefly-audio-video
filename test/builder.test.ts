import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, expect, expectTypeOf, test } from 'vitest';
import { Asset } from '../src/core/asset.js';
import { AudioVideoError } from '../src/core/errors.js';
import type { RenderBuilder } from '../src/dgr/builder.js';
import { createClient, type Client, type ClientConfig } from '../src/dgr/client.js';
import { Preset } from '../src/dgr/preset.js';
import {
  MockApi,
  STORAGE,
  fakeStorage,
  flush,
  recordingLogger,
  running,
  succeeded,
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

test('cancel() before the render starts makes it reject cancelled once awaited, submitting nothing', async () => {
  const builder = client().render(CAPSULE).prores;
  await builder.cancel();
  const error = await rejection(builder);
  expect(error.code).toBe('cancelled');
  expect(api.calls).toEqual([]);
  expect(storage.allocations).toEqual([]);
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
