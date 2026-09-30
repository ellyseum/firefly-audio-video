import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { AudioVideoError } from '../src/core/errors.js';
import { InMemoryPool, type PoolBackend } from '../src/core/pool.js';
import type { StageInput, StorageProvider } from '../src/core/storage.js';
import { createClient, type Client, type ClientConfig } from '../src/dgr/client.js';
import { presets } from '../src/dgr/preset.js';
import type { RenderRequest } from '../src/dgr/schemas.js';
import {
  MockApi,
  STORAGE,
  flush,
  running,
  succeeded,
  until,
  wireOutput,
} from './support/mock-api.js';

const CAPSULE = `${STORAGE}/capsule.mogrt?sv=2021&sp=r&sig=CAPSULE_SIG`;
const WRITE = `${STORAGE}/out/a.mov?sv=2021&sp=w&sig=WRITE_SIG_A`;
const T0 = new Date('2026-09-29T12:00:00.000Z');

/** How far the clock moves while one pool wave of renders runs. */
const RENDER_MS = 60_000;

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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  api = new MockApi();
  api.ims();
});

afterEach(async () => {
  await api.close();
  vi.useRealTimers();
  await flush();
  expect(unhandledRejections.splice(0)).toEqual([]);
});

function client(extra: Partial<ClientConfig> = {}): Client {
  return createClient({ clientId: 'client-id', clientSecret: 'secret', logging: false, ...extra });
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

/** One storage call a {@link probeStorage} saw. */
interface ProbeCall {
  readonly kind: 'stage' | 'allocate';
  readonly input?: StageInput;
  readonly signal: AbortSignal | undefined;
}

/** How a probed call waits before it settles: its position among all calls, and the signal it got. */
type Hold = (index: number, signal: AbortSignal | undefined) => Promise<void>;

/** Two macrotask turns: long enough for calls made together to overlap. */
async function briefly(): Promise<void> {
  await flush();
  await flush();
}

/** Never settles unless `signal` aborts; then rejects the way a transport does. */
function untilAborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('upload aborted')), { once: true });
  });
}

/**
 * A storage provider that records every call, counts how many of each kind
 * are in flight at once, and holds each call open as `hold` says. Every URL
 * it returns carries `at=<Date.now()>` from the moment the call was made.
 */
function probeStorage(hold: Hold = briefly) {
  const calls: ProbeCall[] = [];
  const inFlight = { stage: 0, allocate: 0 };
  const peak = { stage: 0, allocate: 0 };
  const waiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
  function announce(): void {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter !== undefined && calls.length >= waiter.count) {
        waiter.resolve();
        waiters.splice(index, 1);
      }
    }
  }
  async function held<T>(call: ProbeCall, result: (at: number, id: number) => T): Promise<T> {
    const id = calls.push(call);
    announce();
    const at = Date.now();
    inFlight[call.kind] += 1;
    peak[call.kind] = Math.max(peak[call.kind], inFlight[call.kind]);
    try {
      await hold(id - 1, call.signal);
    } finally {
      inFlight[call.kind] -= 1;
    }
    return result(at, id);
  }
  const storage: StorageProvider = {
    stageRead: (input, opts) =>
      held(
        { kind: 'stage', input, signal: opts?.signal },
        (at, id) => `${STORAGE}/staged/${id}?at=${at}&sig=STAGE_SIG_${id}`,
      ),
    allocateOutput: (opts) =>
      held({ kind: 'allocate', signal: opts?.signal }, (at, id) => ({
        writeUrl: `${STORAGE}/out/${id}.mov?at=${at}&sig=WRITE_SIG_${id}`,
        readUrl: `${STORAGE}/out/${id}.mov?at=${at}&sig=READ_SIG_${id}`,
      })),
  };
  /**
   * Resolves the moment `calls` holds at least `count` entries — a signal
   * the stub raises itself the instant it records one, so a slow real
   * upload or filesystem read is waited out in full rather than raced
   * against a fixed number of turns.
   */
  function waitForCalls(count: number): Promise<void> {
    if (calls.length >= count) return Promise.resolve();
    return new Promise((resolve) => waiters.push({ count, resolve }));
  }
  return { storage, calls, peak, waitForCalls };
}

/** One recorded submit: the job ID it was given, its body, and the clock when it arrived. */
interface Submit {
  readonly jobId: string;
  readonly body: Record<string, unknown>;
  readonly at: number;
}

/**
 * Submits answered in order with `jobIds`, each recorded with its body and
 * the clock; every job reports `running` until the test adds it to `done`,
 * then succeeds with one output.
 */
function controlledJobs(jobIds: readonly string[]) {
  const done = new Set<string>();
  const submits: Submit[] = [];
  api.submit([...jobIds], {
    onSubmit: (jobId, body) => submits.push({ jobId, body, at: Date.now() }),
  });
  for (const jobId of jobIds) {
    api.status(jobId, () =>
      done.has(jobId) ? succeeded(jobId, [wireOutput(0, 0, 1, 2)]) : running(jobId),
    );
  }
  return { done, submits };
}

/**
 * Lets a batch through one pool wave at a time: once `width` more jobs have
 * submitted, the clock moves one render's worth and those jobs finish.
 */
async function releaseInWaves(
  total: number,
  width: number,
  jobs: ReturnType<typeof controlledJobs>,
): Promise<void> {
  for (let released = 0; released < total; released += width) {
    await until(() => jobs.submits.length >= Math.min(released + width, total), 5_000);
    vi.setSystemTime(Date.now() + RENDER_MS);
    for (const { jobId } of jobs.submits.slice(released, released + width)) jobs.done.add(jobId);
  }
}

function jobIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `job-${index}`);
}

/** A render whose only storage call is staging its `Buffer` source. */
function bufferSpec(index: number): RenderRequest {
  return {
    source: Buffer.from(`capsule ${index}`),
    presets: ['h264Land1080pHq'],
    outputs: [{ presetIndex: 0, destination: WRITE }],
  };
}

/** The clock reading a probed URL was minted at. */
function mintedAt(url: unknown): number {
  return Number(new URL(String(url)).searchParams.get('at'));
}

test('twelve renders on a pool of two never have more than two inputs staging at once', async () => {
  const pool = new InMemoryPool({ concurrency: 2 });
  const probe = probeStorage();
  const ids = jobIds(12);
  const jobs = controlledJobs(ids);
  const c = client({ pool, storage: probe.storage });

  const renders = ids.map((_, index) => c.render(bufferSpec(index), { pollIntervalMs: 0 }));
  await releaseInWaves(ids.length, 2, jobs);
  await Promise.all(renders);

  expect(probe.calls.filter((call) => call.kind === 'stage')).toHaveLength(12);
  expect(probe.peak.stage).toBe(2);
});

test("a queued render stages when it takes its slot, so its staged URL is no older at submit than the first render's", async () => {
  const pool = new InMemoryPool({ concurrency: 2 });
  const probe = probeStorage();
  const ids = jobIds(12);
  const jobs = controlledJobs(ids);
  const c = client({ pool, storage: probe.storage });

  const renders = ids.map((_, index) => c.render(bufferSpec(index), { pollIntervalMs: 0 }));
  await releaseInWaves(ids.length, 2, jobs);
  await Promise.all(renders);

  const ages = jobs.submits.map(
    ({ body, at }) => at - mintedAt((body.source as { url: string }).url),
  );
  expect(ages).toHaveLength(12);
  const [first] = ages;
  const last = ages[ages.length - 1];
  expect(Math.abs((last ?? 0) - (first ?? 0))).toBeLessThan(1_000);
  expect(Math.max(...ages)).toBeLessThan(RENDER_MS);
});

test('a render cancelled while it is queued, by cancel() or by its signal, makes no storage call at all', async () => {
  const pool = new InMemoryPool({ concurrency: 1 });
  const probe = probeStorage();
  const jobs = controlledJobs(['holder', 'never']);
  const c = client({ pool, storage: probe.storage });
  const holder = c.render(
    {
      source: CAPSULE,
      presets: ['h264Land1080pHq'],
      outputs: [{ presetIndex: 0, destination: WRITE }],
    },
    { pollIntervalMs: 0 },
  );
  await until(() => jobs.submits.length === 1);

  const needsStorage: RenderRequest = {
    source: Buffer.from('capsule'),
    presets: [presets.hevc1080p10bit],
    outputs: [{ presetIndex: 0 }],
  };
  const controller = new AbortController();
  const byCancel = c.render(needsStorage, { pollIntervalMs: 0 });
  const bySignal = c.render(needsStorage, { pollIntervalMs: 0, signal: controller.signal });
  await until(() => pool.queued === 2);

  await byCancel.cancel();
  controller.abort(new Error('caller gave up'));
  expect((await rejection(byCancel)).code).toBe('cancelled');
  expect((await rejection(bySignal)).code).toBe('cancelled');

  jobs.done.add('holder');
  await holder;
  await pool.drain();
  expect(probe.calls).toEqual([]);
  expect(jobs.submits).toHaveLength(1);
});

test('cancelling a render while it stages in its slot aborts the signal its upload got, submits nothing, and lets the next queued render start', async () => {
  const pool = new InMemoryPool({ concurrency: 1 });
  const probe = probeStorage((index, signal) => (index === 0 ? untilAborted(signal) : briefly()));
  const jobs = controlledJobs(['job-next']);
  const c = client({ pool, storage: probe.storage });

  const staging = c.render(bufferSpec(0), { pollIntervalMs: 0 });
  const next = c.render(bufferSpec(1), { pollIntervalMs: 0 });
  await until(() => probe.calls.length === 1);
  expect(pool.queued).toBe(1);

  await staging.cancel();
  const error = await rejection(staging);
  expect(error.code).toBe('cancelled');
  expect(probe.calls[0]?.signal?.aborted).toBe(true);
  expect(staging.jobId).toBeUndefined();

  await until(() => jobs.submits.length === 1);
  jobs.done.add('job-next');
  await next;
  expect(jobs.submits).toHaveLength(1);
  expect(jobs.submits[0]?.body.source).toEqual({ url: expect.stringContaining('/staged/2?') });
});

test('cancelling a describe while its local template uploads in the slot aborts the signal the upload got, and submits nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fav-describe-staging-'));
  const template = join(dir, 'capsule.mogrt');
  writeFileSync(template, 'mogrt bytes');
  try {
    const probe = probeStorage((_index, signal) => untilAborted(signal));
    api.submit(['describe-job'], { path: '/v1/templates/describe' });
    const c = client({ pool: new InMemoryPool({ concurrency: 1 }), storage: probe.storage });

    const describing = c.describe(template);
    // Reading the file on disk takes real time, not only event-loop turns:
    // wait on the stub's own call rather than a fixed number of them.
    await probe.waitForCalls(1);
    expect(probe.calls[0]?.input).toBe(template);

    await describing.cancel();
    const error = await rejection(describing);
    expect(error.code).toBe('cancelled');
    expect(probe.calls[0]?.signal?.aborted).toBe(true);
    expect(describing.jobId).toBeUndefined();
    expect(api.count('POST', '/v1/templates/describe')).toBe(0);
  } finally {
    unlinkSync(template);
    rmdirSync(dir);
  }
});

test("a caller's abort during in-slot staging frees the slot even from a provider that ignores the signal", async () => {
  const pool = new InMemoryPool({ concurrency: 1 });
  const probe = probeStorage((index) => (index === 0 ? new Promise(() => undefined) : briefly()));
  const jobs = controlledJobs(['job-next']);
  const c = client({ pool, storage: probe.storage });
  const controller = new AbortController();

  const staging = c.render(bufferSpec(0), { pollIntervalMs: 0, signal: controller.signal });
  const next = c.render(bufferSpec(1), { pollIntervalMs: 0 });
  await until(() => probe.calls.length === 1);

  const reason = new Error('caller gave up');
  controller.abort(reason);
  const error = await rejection(staging);
  expect(error.code).toBe('cancelled');
  expect(error.cause).toBe(reason);

  await until(() => jobs.submits.length === 1);
  jobs.done.add('job-next');
  await next;
  expect(jobs.submits).toHaveLength(1);
});

/** An in-memory pool of one that counts every `run()` call. */
function countingPool(): PoolBackend & { readonly runs: number } {
  const inner = new InMemoryPool({ concurrency: 1 });
  let runs = 0;
  return {
    run: (task) => {
      runs += 1;
      return inner.run(task);
    },
    drain: () => inner.drain(),
    get active() {
      return inner.active;
    },
    get queued() {
      return inner.queued;
    },
    get runs() {
      return runs;
    },
  };
}

test('a render that fails validation never asks the pool for a slot', async () => {
  const pool = countingPool();
  const probe = probeStorage();
  const withStorage = client({ pool, storage: probe.storage });
  const withoutStorage = client({ pool });
  const cases: Array<[string, () => PromiseLike<unknown>]> = [
    [
      'a mistyped path',
      () => withStorage.render({ ...bufferSpec(0), source: './no/such/capsule.mogrt' }),
    ],
    [
      'an unknown resolveAs',
      () =>
        withStorage.render(bufferSpec(0), {
          resolveAs: 'bytes',
        } as unknown as { resolveAs: 'url' }),
    ],
    ['no storage for an upload', () => withoutStorage.render(bufferSpec(0))],
    ['an invalid spec', () => withStorage.render({ ...bufferSpec(0), outputs: [] })],
  ];

  for (const [what, start] of cases) {
    expect((await rejection(start())).code, what).toBe('invalid_argument');
  }
  expect(pool.runs).toBe(0);
  expect(probe.calls).toEqual([]);
  expect(api.calls).toEqual([]);
});

test('generated .epr presets and outputs without a destination are staged and allocated inside the slot too', async () => {
  const pool = new InMemoryPool({ concurrency: 2 });
  const probe = probeStorage();
  const ids = jobIds(8);
  const jobs = controlledJobs(ids);
  const c = client({ pool, storage: probe.storage });

  const renders = ids.map(() =>
    c.render(
      { source: CAPSULE, presets: [presets.hevc1080p10bit], outputs: [{ presetIndex: 0 }] },
      { pollIntervalMs: 0 },
    ),
  );
  await until(() => jobs.submits.length === 2);
  for (let turn = 0; turn < 10; turn += 1) await flush();
  expect(probe.calls.map((call) => call.kind).sort()).toEqual([
    'allocate',
    'allocate',
    'stage',
    'stage',
  ]);

  await releaseInWaves(ids.length, 2, jobs);
  await Promise.all(renders);
  expect(probe.calls).toHaveLength(16);
  expect(probe.peak).toEqual({ stage: 2, allocate: 2 });
  expect(probe.calls.every((call) => call.signal instanceof AbortSignal)).toBe(true);
});
