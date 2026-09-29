import type { Readable } from 'node:stream';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, expect, expectTypeOf, test } from 'vitest';
import { Asset } from '../src/core/asset.js';
import { AudioVideoError } from '../src/core/errors.js';
import { InMemoryPool } from '../src/core/pool.js';
import type { RenderBuilder } from '../src/dgr/builder.js';
import {
  createClient,
  type Client,
  type ClientConfig,
  type RenderJob,
  type RenderOptions,
} from '../src/dgr/client.js';
import { encode, presets } from '../src/dgr/preset.js';
import type { RenderRequest, RenderRequestOutput } from '../src/dgr/schemas.js';
import {
  API,
  CREATED,
  MockApi,
  STORAGE,
  TOKEN,
  at,
  fakeStorage,
  flush,
  recordingLogger,
  running,
  succeeded,
  succeededWithoutOutputs,
  until,
  wireOutput,
} from './support/mock-api.js';

const SECRET = 'CLIENT_SECRET_VALUE';
const CAPSULE = `${STORAGE}/capsule.mogrt?sv=2021&sp=r&sig=CAPSULE_SIG`;
const WRITE = `${STORAGE}/out/a.mov?sv=2021&sp=w&sig=WRITE_SIG_A`;
const READ = `${STORAGE}/out/a.mov?sv=2021&sp=r&sig=READ_SIG_A`;

let api: MockApi;
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
});

afterEach(async () => {
  await api.close();
  expect(unhandledRejections.splice(0)).toEqual([]);
});

function client(extra: Partial<ClientConfig> = {}): Client {
  return createClient({ clientId: 'client-id', clientSecret: SECRET, logging: false, ...extra });
}

type SingleOutputSpec = Omit<RenderRequest, 'outputs'> & { outputs: [RenderRequestOutput] };

/** A one-output spec — typed as a one-element tuple, so `render()` resolves an `Asset`. */
function singleSpec(overrides: Partial<Omit<RenderRequest, 'outputs'>> = {}): SingleOutputSpec {
  return {
    source: CAPSULE,
    presets: [{ presetId: 'ffs_video_api_land_1080p_hq' }],
    outputs: [{ presetIndex: 0, destination: WRITE, readUrl: READ }],
    ...overrides,
  };
}

/** A job that succeeds on its first poll with one output. */
function succeedsAt(jobId: string, started = 10, completed = 40): void {
  api.status(jobId, () => succeeded(jobId, [wireOutput(0, 0, started, completed, WRITE)]));
}

/** The `AudioVideoError` a promise rejects with. */
async function rejection(promise: PromiseLike<unknown>): Promise<AudioVideoError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AudioVideoError);
    return error as AudioVideoError;
  }
  throw new Error('expected a rejection');
}

/** The `AudioVideoError` `fn` throws synchronously. */
function thrown(fn: () => unknown): AudioVideoError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AudioVideoError);
    return error as AudioVideoError;
  }
  throw new Error('expected a throw');
}

// --- render: the happy path ----------------------------------------------------------

test('render(spec): 202, then poll, then succeeded, resolves an Asset at the output read URL with finite timing', async () => {
  api.submit(['job-1']);
  api.status('job-1', (poll) =>
    poll === 0 ? running('job-1') : succeeded('job-1', [wireOutput(0, 0, 10, 40, WRITE)]),
  );
  const c = client();

  const job = c.render(singleSpec(), { pollIntervalMs: 0 });
  expectTypeOf<Awaited<typeof job>>().toEqualTypeOf<Asset>();
  const asset = await job;

  expect(asset).toBeInstanceOf(Asset);
  expect(asset.url).toBe(READ);
  expect(Number.isFinite(asset.meta.totalMs)).toBe(true);
  expect(asset.meta).toEqual({
    jobId: 'job-1',
    createdAt: Date.parse(CREATED),
    queueMs: 10_000,
    renderMs: 30_000,
    totalMs: 40_000,
    perItem: [{ index: 0, queueMs: 10_000, renderMs: 30_000, totalMs: 40_000 }],
  });
  expect(job.jobId).toBe('job-1');
  expect(job.meta?.totalMs).toBe(40_000);

  const [submit] = api.calls.filter((call) => call.origin === API && call.method === 'POST');
  expect(submit?.headers).toMatchObject({
    Authorization: `Bearer ${TOKEN}`,
    'x-api-key': 'client-id',
  });
  expect(api.submitted()).toEqual([
    {
      source: { url: CAPSULE },
      presets: [{ source: { presetId: 'ffs_video_api_land_1080p_hq' } }],
      outputs: [{ variationIndex: 0, presetIndex: 0, destination: { url: WRITE } }],
    },
  ]);
  const [mint] = api.imsRequests();
  expect(mint?.get('client_id')).toBe('client-id');
  expect(mint?.get('scope')).toBe('openid,AdobeID,firefly_api,ff_apis');
  expect(api.imsRequests()).toHaveLength(1);
});

test('an output without a readUrl is read back from its destination', async () => {
  api.submit(['job-1']);
  succeedsAt('job-1');
  const asset = await client().render(
    {
      source: CAPSULE,
      presets: ['h264Land1080pHq'],
      outputs: [{ presetIndex: 0, destination: WRITE }],
    },
    { pollIntervalMs: 0 },
  );
  expect(asset.url).toBe(WRITE);
});

test('a 202 is never delayed by its Retry-After header, whatever it says', async () => {
  api.submit(['job-1'], { retryAfter: '60' });
  succeedsAt('job-1');
  const asset = await client().render(singleSpec(), { pollIntervalMs: 0 });
  expect(asset.url).toBe(READ);
});

// --- render: several outputs ---------------------------------------------------------

test('two outputs whose wire entries arrive reversed, indexes as strings, resolve Asset[] in spec order with their own timing', async () => {
  const write0 = `${STORAGE}/out/v0.mov?sp=w&sig=W0`;
  const write1 = `${STORAGE}/out/v1.mov?sp=w&sig=W1`;
  const read0 = `${STORAGE}/out/v0.mov?sp=r&sig=R0`;
  const read1 = `${STORAGE}/out/v1.mov?sp=r&sig=R1`;
  api.submit(['job-2']);
  api.status('job-2', () =>
    succeeded('job-2', [wireOutput(1, 0, 20, 45, write1), wireOutput(0, 0, 10, 44, write0)]),
  );
  const spec: RenderRequest = {
    source: CAPSULE,
    presets: ['h264Land1080pHq'],
    variations: [
      { variables: [{ variableId: '0_0_media', assetIndex: 0 }] },
      { variables: [{ variableId: '0_0_media', assetIndex: 1 }] },
    ],
    assets: [`${STORAGE}/a0.png`, `${STORAGE}/a1.png`],
    outputs: [
      { variationIndex: 0, presetIndex: 0, destination: write0, readUrl: read0 },
      { variationIndex: 1, presetIndex: 0, destination: write1, readUrl: read1 },
    ],
  };

  const job = client().render(spec, { pollIntervalMs: 0 });
  expectTypeOf<Awaited<typeof job>>().toEqualTypeOf<Asset | Asset[]>();
  const assets = await job;

  expect(Array.isArray(assets)).toBe(true);
  const [first, second] = assets as Asset[];
  expect(first?.url).toBe(read0);
  expect(second?.url).toBe(read1);
  expect(first?.meta).toMatchObject({ jobId: 'job-2', queueMs: 10_000, totalMs: 44_000 });
  expect(first?.meta.perItem).toEqual([
    { index: 0, queueMs: 10_000, renderMs: 34_000, totalMs: 44_000 },
  ]);
  expect(second?.meta).toMatchObject({ jobId: 'job-2', queueMs: 20_000, totalMs: 45_000 });
  expect(second?.meta.perItem).toEqual([
    { index: 1, queueMs: 20_000, renderMs: 25_000, totalMs: 45_000 },
  ]);
});

test('outputs sharing a variationIndex and presetIndex are told apart by destination', async () => {
  const writeA = `${STORAGE}/out/a.mov?sp=w&sig=WA`;
  const writeB = `${STORAGE}/out/b.mov?sp=w&sig=WB`;
  api.submit(['job-3']);
  api.status('job-3', () =>
    succeeded('job-3', [wireOutput(0, 0, 30, 50, writeB), wireOutput(0, 0, 5, 50, writeA)]),
  );
  const assets = (await client().render(
    {
      source: CAPSULE,
      presets: ['h264Land1080pHq'],
      outputs: [
        { presetIndex: 0, destination: writeA },
        { presetIndex: 0, destination: writeB },
      ],
    },
    { pollIntervalMs: 0 },
  )) as Asset[];
  expect(assets.map((asset) => asset.meta.queueMs)).toEqual([5_000, 30_000]);
});

test('a spec output the terminal status does not list rejects invalid_response naming its pair', async () => {
  api.submit(['job-4']);
  api.status('job-4', () => succeeded('job-4', []));
  const error = await rejection(client().render(singleSpec(), { pollIntervalMs: 0 }));
  expect(error.code).toBe('invalid_response');
  expect(error.jobId).toBe('job-4');
  expect(error.message).toContain('variationIndex=0');
  expect(error.message).toContain('presetIndex=0');
  expect(error.message).not.toContain(READ);
  expect(error.message).not.toContain(WRITE);
});

test('a wire output the spec did not declare rejects invalid_response naming its pair, never its URL', async () => {
  api.submit(['job-4b']);
  api.status('job-4b', () =>
    succeeded('job-4b', [
      wireOutput(0, 0, 10, 40, WRITE),
      wireOutput(7, 0, 10, 40, `${STORAGE}/out/extra.mov`),
    ]),
  );
  const error = await rejection(client().render(singleSpec(), { pollIntervalMs: 0 }));
  expect(error.code).toBe('invalid_response');
  expect(error.jobId).toBe('job-4b');
  expect(error.message).toContain('variationIndex=7');
  expect(error.message).not.toContain(STORAGE);
});

test('a terminal status with no outputs at all rejects invalid_response', async () => {
  api.submit(['job-4c']);
  api.status('job-4c', () => succeededWithoutOutputs('job-4c'));
  const error = await rejection(client().render(singleSpec(), { pollIntervalMs: 0 }));
  expect(error.code).toBe('invalid_response');
  expect(error.jobId).toBe('job-4c');
});

// --- render: presets -----------------------------------------------------------------

test('named presets are submitted as their presetId wrapped in source', async () => {
  api.submit(['job-5']);
  succeedsAt('job-5');
  await client().render(
    singleSpec({ presets: [presets.h264Square1080pHq, 'prores', 'ffs_video_api_vert_1920p_lq'] }),
    { pollIntervalMs: 0 },
  );
  expect(api.submitted()[0]?.presets).toEqual([
    { source: { presetId: 'ffs_video_api_square_1080p_hq' } },
    { source: { presetId: 'ffs_video_api_prores' } },
    { source: { presetId: 'ffs_video_api_vert_1920p_lq' } },
  ]);
});

test('a config preset stages its generated .epr once through storage and submits its URL', async () => {
  const storage = fakeStorage();
  api.submit(['job-6']);
  succeedsAt('job-6');
  await client({ storage }).render(singleSpec({ presets: [presets.hevc1080p10bit] }), {
    pollIntervalMs: 0,
  });

  expect(storage.staged).toHaveLength(1);
  const [staged] = storage.staged;
  expect(Buffer.isBuffer(staged?.input)).toBe(true);
  expect((staged?.input as Buffer).toString('utf8')).toContain('<PremiereData');
  expect(staged?.opts).toEqual({ contentType: 'application/xml' });
  expect(api.submitted()[0]?.presets).toEqual([
    { source: { url: `${STORAGE}/staged/1.epr?sv=2021&sp=r&sig=STAGE_SIG_1` } },
  ]);
});

test('a config preset equal to a native preset is submitted as that presetId and needs no storage', async () => {
  api.submit(['job-7']);
  succeedsAt('job-7');
  await client().render(
    singleSpec({ presets: [encode({ codec: 'h264', resolution: '1920x1080', mode: 'hq' })] }),
    { pollIntervalMs: 0 },
  );
  expect(api.submitted()[0]?.presets).toEqual([
    { source: { presetId: 'ffs_video_api_land_1080p_hq' } },
  ]);
});

test('a preset that needs staging with no storage configured rejects invalid_argument naming the option, before any request', async () => {
  const error = await rejection(client().render(singleSpec({ presets: [presets.prores4444xq] })));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('storage option');
  expect(error.message).toContain('presets[0]');
  expect(api.calls).toEqual([]);
});

test('an unknown preset rejects invalid_preset naming the entry it came from', async () => {
  const error = await rejection(
    client().render(singleSpec({ presets: ['h264Land1080pHq', 'bogus'] })),
  );
  expect(error.code).toBe('invalid_preset');
  expect(error.message.startsWith('presets[1]: ')).toBe(true);
  expect(api.calls).toEqual([]);
});

test('an invalid spec rejects invalid_argument before any request', async () => {
  const c = client();
  const notASpec = await rejection(c.render({ source: CAPSULE } as unknown as RenderRequest));
  expect(notASpec.code).toBe('invalid_argument');
  const outOfRange = await rejection(
    c.render({
      source: CAPSULE,
      presets: ['prores'],
      outputs: [{ presetIndex: 1, destination: WRITE }],
    }),
  );
  expect(outOfRange.code).toBe('invalid_argument');
  expect(outOfRange.message).toContain('outputs[0].presetIndex');
  const noVariation = await rejection(
    c.render({
      source: CAPSULE,
      presets: ['prores'],
      outputs: [{ variationIndex: 1, presetIndex: 0, destination: WRITE }],
    }),
  );
  expect(noVariation.message).toContain('outputs[0].variationIndex');
  expect(api.calls).toEqual([]);
});

// --- render: resolveAs ------------------------------------------------------------------

test("resolveAs: 'buffer' resolves the output's bytes", async () => {
  const bytes = Buffer.from([0xff, 0x00, 0x7f, 0x80]);
  api.submit(['job-8']);
  succeedsAt('job-8');
  api.download('/out/a.mov', bytes);

  const job = client().render(singleSpec(), { resolveAs: 'buffer', pollIntervalMs: 0 });
  expectTypeOf<Awaited<typeof job>>().toEqualTypeOf<Buffer>();
  expect(Buffer.compare(await job, bytes)).toBe(0);
});

test('resolveAs return types follow the mode', () => {
  const c = client();
  const spec = singleSpec();
  // Types only: each job's signal is already aborted, so it submits nothing and settles on its own.
  const signal = AbortSignal.abort();
  expectTypeOf(c.render(spec, { resolveAs: 'url', signal })).toEqualTypeOf<RenderJob<string>>();
  expectTypeOf(c.render(spec, { resolveAs: 'stream', signal })).toEqualTypeOf<
    RenderJob<Readable>
  >();
  expectTypeOf(c.render(spec, { resolveAs: 'file', savePath: './out.mov', signal })).toEqualTypeOf<
    RenderJob<string>
  >();
  expectTypeOf(c.render(CAPSULE)).toEqualTypeOf<RenderBuilder>();
});

test('resolveAs on a multi-output spec rejects invalid_argument before any request', async () => {
  const error = await rejection(
    client().render(
      {
        source: CAPSULE,
        presets: ['prores'],
        outputs: [
          { presetIndex: 0, destination: WRITE },
          { presetIndex: 0, destination: `${WRITE}&n=2` },
        ],
      },
      { resolveAs: 'buffer' },
    ),
  );
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('resolve each asset yourself');
  expect(api.calls).toEqual([]);
});

test("resolveAs: 'file' without a savePath, or an unknown mode, rejects before any request", async () => {
  const c = client();
  const noPath = await rejection(c.render(singleSpec(), { resolveAs: 'file' }));
  expect(noPath.code).toBe('invalid_argument');
  const unknownMode = await rejection(
    c.render(singleSpec(), { resolveAs: 'bytes' } as unknown as RenderOptions),
  );
  expect(unknownMode.code).toBe('invalid_argument');
  expect(api.calls).toEqual([]);
});

// --- logging -------------------------------------------------------------------------------

/** Every string a record must never carry. */
const SECRETS = ['sig=', SECRET, TOKEN, 'WRITE_SIG', 'READ_SIG', 'CAPSULE_SIG', 'STAGE_SIG'];

test('a settled render emits exactly one redacted record carrying its timing and preset', async () => {
  const logger = recordingLogger();
  api.submit(['job-9']);
  succeedsAt('job-9');
  await client({ logging: logger }).render(singleSpec({ presets: ['h264Land1080pHq'] }), {
    pollIntervalMs: 0,
  });
  await flush();

  expect(logger.records).toHaveLength(1);
  const [record] = logger.records;
  expect(record).toMatchObject({
    level: 'info',
    msg: 'render completed',
    endpoint: 'POST /v1/templates/render',
    jobId: 'job-9',
    queueMs: 10_000,
    renderMs: 30_000,
    totalMs: 40_000,
    preset: 'ffs_video_api_land_1080p_hq',
    codec: 'h264',
    resolution: '1920x1080',
    totalJobItems: 1,
    status: 'succeeded',
  });
  const text = JSON.stringify(record);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
});

test('a failed render emits exactly one redacted error record', async () => {
  const logger = recordingLogger();
  api.submit(['job-10']);
  api.status('job-10', () => ({
    jobId: 'job-10',
    status: 'failed',
    createdDate: CREATED,
    totalJobItems: 1,
    outputs: [
      {
        variationIndex: '0',
        presetIndex: '0',
        startedDate: at(1),
        completedDate: at(2),
        errors: [{ message: `could not write ${WRITE}` }],
      },
    ],
  }));
  const error = await rejection(
    client({ logging: logger }).render(singleSpec(), { pollIntervalMs: 0 }),
  );
  await flush();

  expect(error.code).toBe('job_failed');
  expect(logger.records).toHaveLength(1);
  const [record] = logger.records;
  expect(record).toMatchObject({
    level: 'error',
    msg: 'render failed',
    jobId: 'job-10',
    status: 'failed',
    totalJobItems: 1,
  });
  expect(record?.error?.startsWith('job_failed: ')).toBe(true);
  const text = JSON.stringify(record);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
});

test('a render that fails before submitting emits exactly one record, with no job ID', async () => {
  const logger = recordingLogger();
  await rejection(
    client({ logging: logger }).render(singleSpec({ presets: [presets.prores4444xq] })),
  );
  await flush();
  expect(logger.records).toHaveLength(1);
  expect(logger.records[0]).toMatchObject({ level: 'error', msg: 'render failed' });
  expect(logger.records[0]?.jobId).toBeUndefined();
  expect(logger.records[0]?.error?.startsWith('invalid_argument: ')).toBe(true);
});

test('a cancelled render emits one warn record', async () => {
  const logger = recordingLogger();
  const job = client({ logging: logger }).render(singleSpec(), { signal: AbortSignal.abort() });
  await rejection(job);
  await flush();
  expect(logger.records).toHaveLength(1);
  expect(logger.records[0]).toMatchObject({ level: 'warn', msg: 'render cancelled' });
});

// --- the pool --------------------------------------------------------------------------------

test('with concurrency 2, five renders never have more than two submitted jobs unfinished', async () => {
  const jobIds = ['j0', 'j1', 'j2', 'j3', 'j4'];
  const timeline: string[] = [];
  let open = false;
  api.submit(jobIds, { onSubmit: (jobId) => timeline.push(`submit:${jobId}`) });
  for (const jobId of jobIds) {
    api.status(jobId, () => {
      if (!open) return running(jobId);
      timeline.push(`done:${jobId}`);
      return succeeded(jobId, [wireOutput(0, 0, 1, 2, WRITE)]);
    });
  }
  const c = client({ concurrency: 2 });

  const jobs = jobIds.map(() => c.render(singleSpec(), { pollIntervalMs: 1 }));
  await until(() => timeline.length >= 2);
  for (let turn = 0; turn < 20; turn += 1) await flush();
  expect(timeline).toEqual(['submit:j0', 'submit:j1']);

  open = true;
  const assets = await Promise.all(jobs);
  expect(assets).toHaveLength(5);

  let unfinished = 0;
  let maxUnfinished = 0;
  for (const event of timeline) {
    unfinished += event.startsWith('submit:') ? 1 : -1;
    maxUnfinished = Math.max(maxUnfinished, unfinished);
  }
  expect(maxUnfinished).toBe(2);
  expect(timeline.filter((event) => event.startsWith('submit:'))).toHaveLength(5);
});

test('cancel() before pool admission submits nothing and rejects cancelled; the slot it never used stays free', async () => {
  const pool = new InMemoryPool({ concurrency: 1 });
  let open = false;
  api.submit(['j0', 'j1']);
  api.status('j0', () => (open ? succeeded('j0', [wireOutput(0, 0, 1, 2, WRITE)]) : running('j0')));
  const c = client({ pool });

  const first = c.render(singleSpec(), { pollIntervalMs: 1 });
  await until(() => api.count('POST', '/v1/templates/render') === 1);
  const queued = c.render(singleSpec(), { pollIntervalMs: 1 });
  await flush();
  expect(pool.queued).toBe(1);

  await queued.cancel();
  const error = await rejection(queued);
  expect(error.code).toBe('cancelled');
  expect(queued.jobId).toBeUndefined();

  open = true;
  await first;
  for (let turn = 0; turn < 10; turn += 1) await flush();
  expect(api.count('POST', '/v1/templates/render')).toBe(1);
  expect(api.count('GET', '/v1/status/j1')).toBe(0);
  expect(api.count('PUT', '/v1/cancel/')).toBe(0);
  await pool.drain();
  expect(pool.active).toBe(0);
  expect(
    api.calls.every(
      (call) => call.origin !== API || call.path.includes('j0') || call.method === 'POST',
    ),
  ).toBe(true);
});

test('at concurrency 1, renders whose presets need staging complete: staging never waits on the pool', async () => {
  const storage = fakeStorage();
  api.submit(['j0', 'j1']);
  succeedsAt('j0');
  succeedsAt('j1');
  const c = client({ concurrency: 1, storage });
  const assets = await Promise.all([
    c.render(singleSpec({ presets: [presets.hevc1080p10bit] }), { pollIntervalMs: 0 }),
    c.render(singleSpec({ presets: [presets.prores4444xq] }), { pollIntervalMs: 0 }),
  ]);
  expect(assets).toHaveLength(2);
  expect(storage.staged).toHaveLength(2);
});

test('status, cancel, listPresets and stage take no pool slot', async () => {
  const pool = new InMemoryPool({ concurrency: 1 });
  const storage = fakeStorage();
  api.submit(['j0']);
  api.status('j0', () => running('j0'));
  api.status('job-x', () => running('job-x'));
  api.cancel('job-x');
  api.reply('GET', '/v1/presets', 200, { items: [{ presetId: 'ffs_video_api_prores' }] });
  const c = client({ pool, storage });

  const holder = c.render(singleSpec(), { pollIntervalMs: 1 });
  await until(() => pool.active === 1 && holder.jobId !== undefined);

  await expect(c.status('job-x')).resolves.toMatchObject({ status: 'running' });
  await expect(c.cancel('job-x')).resolves.toEqual({ jobId: 'job-x', status: 'canceling' });
  await expect(c.listPresets()).resolves.toHaveLength(1);
  await expect(c.stage(Buffer.from('x'))).resolves.toMatch(/^https:\/\/storage\.example\//);

  api.cancel('j0');
  await holder.cancel();
  await rejection(holder);
});

// --- cancellation ----------------------------------------------------------------------------

test('a signal aborted before the call rejects cancelled with the reason as cause and submits nothing', async () => {
  const controller = new AbortController();
  const reason = new Error('stop');
  controller.abort(reason);
  const error = await rejection(client().render(singleSpec(), { signal: controller.signal }));
  expect(error.code).toBe('cancelled');
  expect(error.cause).toBe(reason);
  expect(api.calls).toEqual([]);
});

test('cancel() after the submit asks the service to stop the job and rejects cancelled', async () => {
  api.submit(['job-11']);
  api.status('job-11', () => running('job-11'));
  api.cancel('job-11');
  const job = client().render(singleSpec(), { pollIntervalMs: 1 });
  await until(() => job.jobId === 'job-11');

  await job.cancel();
  const error = await rejection(job);
  expect(error).toMatchObject({ code: 'cancelled', jobId: 'job-11' });
  expect(api.count('PUT', '/v1/cancel/job-11')).toBe(1);
});

test('util.inspect of a render job shows its job ID and state, nothing else', async () => {
  api.submit(['job-12']);
  succeedsAt('job-12');
  const job = client().render(singleSpec(), { pollIntervalMs: 0 });
  await job;
  expect(inspect(job)).toBe(inspect({ jobId: 'job-12', state: 'fulfilled' }));
});

// --- describe ---------------------------------------------------------------------------------

test('describe resolves the controls and fonts a terminal describe body nests under output', async () => {
  api.submit(['d-1'], { path: '/v1/templates/describe' });
  api.status('d-1', () => ({
    jobId: 'd-1',
    status: 'succeeded',
    output: {
      fonts: [{ name: 'TimesNewRomanPSMT', uploadRequired: false }],
      elements: [
        {
          type: 'mogrt',
          controls: [
            {
              variableId: '0_0_media',
              label: 'Inner',
              type: 'media',
              size: { width: 1920, height: 1080 },
              possibleScaleValues: ['no_scale', 'fit_to_frame'],
              editableProperties: ['asset', 'scale'],
            },
            { variableId: '0_1_media', label: '{{qr}}', type: 'media' },
            { label: 'not a control' },
          ],
        },
      ],
    },
  }));

  const job = client().describe(new URL(CAPSULE), { pollIntervalMs: 0 });
  const description = await job;

  expect(description.controls.map((control) => control.variableId)).toEqual([
    '0_0_media',
    '0_1_media',
  ]);
  expect(description.controls[0]).toMatchObject({
    type: 'media',
    size: { width: 1920, height: 1080 },
  });
  expect(description.fonts).toEqual([{ name: 'TimesNewRomanPSMT', uploadRequired: false }]);
  expect(api.submitted('/v1/templates/describe')).toEqual([{ source: { url: CAPSULE } }]);
  expect(job.jobId).toBe('d-1');
});

test('describe of an After Effects project without a compName rejects before any request', async () => {
  const error = await rejection(client().describe({ source: { url: CAPSULE }, type: 'aep' }));
  expect(error.code).toBe('invalid_argument');
  expect(api.calls).toEqual([]);
});

// --- status, cancel, listPresets, stage -------------------------------------------------------

test('status reads the raw status body', async () => {
  const body = { jobId: 'job-13', status: 'running', createdDate: CREATED, totalJobItems: 3 };
  api.status('job-13', () => body);
  await expect(client().status('job-13')).resolves.toEqual(body);
  const missing = await rejection(client().status(''));
  expect(missing.code).toBe('invalid_argument');
});

test("cancel resolves the service's canceling acknowledgement", async () => {
  api.cancel('job-14');
  await expect(client().cancel('job-14')).resolves.toEqual({
    jobId: 'job-14',
    status: 'canceling',
  });
  expect(api.count('PUT', '/v1/cancel/job-14')).toBe(1);
});

test('listPresets unwraps the items list', async () => {
  const items = [
    { presetId: 'ffs_video_api_land_1080p_hq', label: 'Landscape 1920x1080 - HQ', codec: 'H.264' },
    { presetId: 'ffs_video_api_prores', label: 'ProRes', codec: 'ProRes 4444' },
  ];
  api.reply('GET', '/v1/presets', 200, { items });
  await expect(client().listPresets()).resolves.toEqual(items);
});

test('the single-request calls each emit one record', async () => {
  const logger = recordingLogger();
  api.status('job-15', () => ({ jobId: 'job-15', status: 'succeeded', totalJobItems: 2 }));
  api.cancel('job-15');
  api.reply('GET', '/v1/presets', 200, { items: [] });
  const c = client({ logging: logger, storage: fakeStorage() });

  await c.status('job-15');
  await c.cancel('job-15');
  await c.listPresets();
  await c.stage(Buffer.from('x'));
  await rejection(c.status('  '));

  expect(
    logger.records.map(({ msg, endpoint, jobId, status }) => ({ msg, endpoint, jobId, status })),
  ).toEqual([
    {
      msg: 'status completed',
      endpoint: 'GET /v1/status/{jobId}',
      jobId: 'job-15',
      status: 'succeeded',
    },
    {
      msg: 'cancel completed',
      endpoint: 'PUT /v1/cancel/{jobId}',
      jobId: 'job-15',
      status: 'canceling',
    },
    {
      msg: 'list presets completed',
      endpoint: 'GET /v1/presets',
      jobId: undefined,
      status: undefined,
    },
    { msg: 'stage completed', endpoint: 'stage', jobId: undefined, status: undefined },
    {
      msg: 'status failed',
      endpoint: 'GET /v1/status/{jobId}',
      jobId: undefined,
      status: undefined,
    },
  ]);
});

test('a raw transport failure on status, cancel or listPresets is wrapped as request_failed with a redacted cause', async () => {
  const secretUrl = `${STORAGE}/leak?sv=2021&sp=r&sig=LEAKED_SIG`;
  api.agent
    .get(API)
    .intercept({ path: '/v1/status/job-x', method: 'GET' })
    .replyWithError(new Error(`fetch failed reaching ${secretUrl}`));
  api.agent
    .get(API)
    .intercept({ path: '/v1/cancel/job-x', method: 'PUT' })
    .replyWithError(new Error(`fetch failed reaching ${secretUrl}`));
  api.agent
    .get(API)
    .intercept({ path: '/v1/presets', method: 'GET' })
    .replyWithError(new Error(`fetch failed reaching ${secretUrl}`));

  for (const call of [
    () => client().status('job-x'),
    () => client().cancel('job-x'),
    () => client().listPresets(),
  ]) {
    const error = await rejection(call());
    expect(error.code).toBe('request_failed');
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).not.toContain('LEAKED_SIG');
  }
});

test('an already-aborted signal on status, cancel or listPresets is wrapped as cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  for (const call of [
    () => client().status('job-x', { signal: controller.signal }),
    () => client().cancel('job-x', { signal: controller.signal }),
    () => client().listPresets({ signal: controller.signal }),
  ]) {
    const error = await rejection(call());
    expect(error.code).toBe('cancelled');
  }
});

test('stage uploads through storage and resolves its read URL', async () => {
  const storage = fakeStorage();
  const input = Buffer.from('png bytes');
  const url = await client({ storage }).stage(input, { contentType: 'image/png', key: 'logo.png' });
  expect(url).toBe(`${STORAGE}/staged/1.epr?sv=2021&sp=r&sig=STAGE_SIG_1`);
  expect(storage.staged).toEqual([{ input, opts: { key: 'logo.png', contentType: 'image/png' } }]);
});

test('stage without storage rejects invalid_argument naming the option; a failing provider rejects storage_failed', async () => {
  const noStorage = await rejection(client().stage(Buffer.from('x')));
  expect(noStorage.code).toBe('invalid_argument');
  expect(noStorage.message).toContain('storage option');

  const cause = new Error('bucket unreachable');
  const failing = await rejection(
    client({
      storage: {
        stageRead: () => Promise.reject(cause),
        allocateOutput: () => Promise.reject(cause),
      },
    }).stage(Buffer.from('x')),
  );
  expect(failing.code).toBe('storage_failed');
  expect(failing.cause).toBe(cause);
});

// --- config -------------------------------------------------------------------------------------

test('a tokenProvider authenticates without IMS, and clientId is still sent as x-api-key', async () => {
  api.status('job-16', () => running('job-16'));
  const c = createClient({
    clientId: 'provider-client',
    tokenProvider: { getAccessToken: async () => 'PROVIDED_TOKEN' },
    logging: false,
  });
  await c.status('job-16');
  expect(api.imsRequests()).toHaveLength(0);
  expect(api.calls[0]?.headers).toMatchObject({
    Authorization: 'Bearer PROVIDED_TOKEN',
    'x-api-key': 'provider-client',
  });
});

test('an invalid config throws invalid_argument from createClient', () => {
  const base = { clientId: 'id', clientSecret: 'secret', logging: false as const };
  const invalid: unknown[] = [
    undefined,
    { clientSecret: 'secret' },
    { clientId: '  ', clientSecret: 'secret' },
    { clientId: 'id' },
    { clientId: 'id', clientSecret: 'secret', tokenProvider: { getAccessToken: async () => 't' } },
    { clientId: 'id', tokenProvider: { getAccessToken: async () => 't' }, scope: 'openid' },
    { clientId: 'id', tokenProvider: {} },
    { ...base, concurrency: 0 },
    { ...base, retry: { maxRetries: -1 } },
    { ...base, host: 'ftp://example.com' },
    { ...base, storage: { stageRead: () => '' } },
    { ...base, pool: {} },
    { ...base, logging: 'loud' },
    { ...base, scope: '["openid",' },
  ];
  for (const config of invalid) {
    expect(thrown(() => createClient(config as ClientConfig)).code).toBe('invalid_argument');
  }
});

test('a scope given as a JSON-array string or an array is sent to IMS as one comma-joined string', async () => {
  for (const scope of [
    '["openid","AdobeID","firefly_api"]',
    ['openid', 'AdobeID', 'firefly_api'],
  ]) {
    api.status('job-17', () => running('job-17'));
    await client({ scope }).status('job-17');
  }
  expect(api.imsRequests().map((mint) => mint.get('scope'))).toEqual([
    'openid,AdobeID,firefly_api',
    'openid,AdobeID,firefly_api',
  ]);
});

test('a { client } option that did not come from createClient rejects invalid_argument', async () => {
  const fake = { render: () => undefined } as unknown as Client;
  const error = await rejection(client().render(singleSpec(), { client: fake }));
  expect(error.code).toBe('invalid_argument');
  const statusError = await rejection(client().status('job-1', { client: fake }));
  expect(statusError.code).toBe('invalid_argument');
});

test('a { client } option that did not come from createClient still emits exactly one record, on every public call', async () => {
  const fake = { render: () => undefined } as unknown as Client;
  const logger = recordingLogger();
  const c = client({ logging: logger });

  await rejection(c.render(singleSpec(), { client: fake }));
  await rejection(c.describe(CAPSULE, { client: fake }));
  await rejection(c.status('job-1', { client: fake }));
  await rejection(c.cancel('job-1', { client: fake }));
  await rejection(c.listPresets({ client: fake }));
  await rejection(c.stage(Buffer.from('x'), { client: fake }));
  await flush();

  expect(logger.records).toHaveLength(6);
  for (const record of logger.records) {
    expect(record.level).toBe('error');
    expect(record.error?.startsWith('invalid_argument: ')).toBe(true);
  }
});

test('a { client } option on a client method runs the call on that client', async () => {
  api.status('job-18', () => running('job-18'));
  const other = createClient({ clientId: 'other-id', clientSecret: 'other', logging: false });
  await client().status('job-18', { client: other });
  expect(api.calls.find((call) => call.origin === API)?.headers).toMatchObject({
    'x-api-key': 'other-id',
  });
});

test('the client exposes the preset catalog', () => {
  const c = client();
  expect(c.presets).toBe(presets);
  expect(c.encode).toBe(encode);
  expect(c.presets.prores4444xq.toJSON()).toEqual(presets.prores4444xq.toJSON());
  expect(c.resize('9:16').toJSON().config).toEqual({ resolution: '1080x1920' });
});
