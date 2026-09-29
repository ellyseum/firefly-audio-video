import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TokenProvider } from '../src/core/auth.js';
import { AudioVideoError } from '../src/core/errors.js';
import { DEFAULT_HOST, HttpClient } from '../src/core/http.js';
import { AsyncJob, DEFAULT_MAX_POLL_FAILURES, parseTimings, runJob } from '../src/core/job.js';
import type { JobItemLike, JobStatusLike, JobSubmission } from '../src/core/job.js';
import type { JobStatusResponse } from '../src/dgr/types.js';
import { deferred } from './support/fake-ims.js';
import { until } from './support/mock-api.js';

const originalDispatcher = getGlobalDispatcher();
let agent: MockAgent;
const tokenProvider: TokenProvider = { getAccessToken: () => Promise.resolve('TOKEN') };

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  vi.useRealTimers();
  await agent.close();
  setGlobalDispatcher(originalDispatcher);
});

const STATUS_PATH = '/v1/status/j1';
const STATUS_URL = `${DEFAULT_HOST}${STATUS_PATH}`;
const CANCEL_PATH = '/v1/cancel/j1';
const CREATED = '2026-09-29T12:00:00.000Z';

/** `CREATED` plus `seconds`, with an optional fractional-second suffix replacing `.000`. */
function at(seconds: number, fraction = '.000'): string {
  return new Date(Date.parse(CREATED) + seconds * 1000).toISOString().replace('.000', fraction);
}

function pool() {
  return agent.get(DEFAULT_HOST);
}

function http(): HttpClient {
  return new HttpClient({ apiKey: 'key', tokenProvider });
}

const submitJ1 = () => Promise.resolve({ jobId: 'j1', statusUrl: STATUS_URL });

/** Queues one status reply per body, consumed in order. */
function statusReplies(...bodies: object[]): void {
  for (const body of bodies) {
    pool().intercept({ path: STATUS_PATH, method: 'GET' }).reply(200, body);
  }
}

/** A status endpoint that always answers `running`; returns a reader for how many polls it saw. */
function runningForever(): () => number {
  let polls = 0;
  pool()
    .intercept({ path: STATUS_PATH, method: 'GET' })
    .reply(200, () => {
      polls += 1;
      return { jobId: 'j1', status: 'running' };
    })
    .persist();
  return () => polls;
}

/** A cancel endpoint answering `status`; returns a reader for how many calls it saw. */
function cancelEndpoint(status = 200): () => number {
  let calls = 0;
  pool()
    .intercept({ path: CANCEL_PATH, method: 'PUT' })
    .reply(status, () => {
      calls += 1;
      return status === 200 ? '' : { error: 'cancel failed' };
    })
    .persist();
  return () => calls;
}

/** A status endpoint that always answers `status` with an error body; returns the poll count and the clock time of each poll. */
function failingForever(status: number): { polls: () => number; times: number[] } {
  const times: number[] = [];
  pool()
    .intercept({ path: STATUS_PATH, method: 'GET' })
    .reply(status, () => {
      times.push(Date.now());
      return { error: `status ${status}` };
    })
    .persist();
  return { polls: () => times.length, times };
}

/**
 * A status endpoint answering a script in order — a number is that HTTP status with an error body,
 * an object is a 200 body; a poll past the end of the script answers 500. Returns the poll count.
 */
function scriptedStatus(...script: Array<number | object>): () => number {
  let polls = 0;
  pool()
    .intercept({ path: STATUS_PATH, method: 'GET' })
    .reply(() => {
      const step = script[polls] ?? 500;
      polls += 1;
      return typeof step === 'number'
        ? { statusCode: step, data: { error: `status ${step}` } }
        : { statusCode: 200, data: step };
    })
    .persist();
  return () => polls;
}

/** A client whose GET calls are counted, whatever each one's outcome. */
function countingHttp(): { client: HttpClient; gets: () => number } {
  const client = http();
  const request = vi.spyOn(client, 'request');
  return { client, gets: () => request.mock.calls.filter(([method]) => method === 'GET').length };
}

/** An `onProgress` recorder whose `first` resolves on the first poll — a deterministic "the job is now polling" signal. */
function progressGate(): {
  onProgress: (status: JobStatusLike) => void;
  first: Promise<void>;
  calls: JobStatusLike[];
} {
  const calls: JobStatusLike[] = [];
  let resolveFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  return {
    calls,
    first,
    onProgress: (status) => {
      calls.push(status);
      if (calls.length === 1) resolveFirst();
    },
  };
}

/** The job's settlement as a value: the rejection error, or `undefined` when it resolved. */
function rejectionOf(job: PromiseLike<unknown>): Promise<AudioVideoError | undefined> {
  return Promise.resolve(job).then(
    () => undefined,
    (err: unknown) => err as AudioVideoError,
  );
}

/** True iff `p` has NOT settled once its settlement handlers have had a few microtask turns to run. */
async function isPending(p: PromiseLike<unknown>): Promise<boolean> {
  let pending = true;
  void p.then(
    () => {
      pending = false;
    },
    () => {
      pending = false;
    },
  );
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  return pending;
}

/** One real macrotask turn — for tests running on real timers only. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// --- submit → poll → resolve -------------------------------------------------------

test('202 submit → running → completed resolves mapResult with the terminal body and its timing', async () => {
  pool()
    .intercept({ path: '/v1/templates/render', method: 'POST' })
    .reply(202, { jobId: 'j1', statusUrl: STATUS_URL });
  statusReplies(
    { jobId: 'j1', status: 'running', createdDate: CREATED, outputs: [{ startedDate: at(2.5) }] },
    {
      jobId: 'j1',
      status: 'completed',
      createdDate: CREATED,
      outputs: [
        {
          startedDate: at(2.5),
          completedDate: at(12, '.123456789'),
          destination: { url: 'https://out.example/f.mov?sig=SECRET' },
        },
      ],
    },
  );

  const client = http();
  const job = runJob(client, {
    submit: () =>
      client
        .request<JobSubmission>('POST', '/v1/templates/render', { source: { url: 'https://x/y' } })
        .then((res) => res.body),
    mapResult: (terminal, meta) => ({ status: terminal.status, meta }),
    pollIntervalMs: 0,
  });

  expect(job).toBeInstanceOf(AsyncJob);
  expect(job.jobId).toBeUndefined();

  const result = await job;

  expect(result.status).toBe('completed');
  expect(job.jobId).toBe('j1');
  expect(result.meta).toBe(job.meta);
  expect(job.meta).toEqual({
    jobId: 'j1',
    createdAt: Date.parse(CREATED),
    queueMs: 2_500,
    renderMs: 9_623,
    totalMs: 12_123,
    perItem: [{ index: 0, queueMs: 2_500, renderMs: 9_623, totalMs: 12_123 }],
  });
  expect(agent.pendingInterceptors()).toHaveLength(0);
});

test('the job is a thenable and a handle: await, then-chaining, catch, finally, Promise.all', async () => {
  statusReplies({ status: 'completed' });
  const job = runJob(http(), { submit: submitJ1, mapResult: () => 'done', pollIntervalMs: 0 });

  const [viaAll] = await Promise.all([job]);
  expect(viaAll).toBe('done');
  expect(await job.then((v) => `${v}!`)).toBe('done!');
  let finallyRan = false;
  expect(
    await job.finally(() => {
      finallyRan = true;
    }),
  ).toBe('done');
  expect(finallyRan).toBe(true);
  expect(await job.catch(() => 'unreached')).toBe('done');
});

test('terminal status matching is case-insensitive', async () => {
  statusReplies({ status: 'SUCCEEDED' });
  const result = await runJob(http(), {
    submit: submitJ1,
    mapResult: () => 'ok',
    pollIntervalMs: 0,
  });
  expect(result).toBe('ok');
});

test('onProgress fires once per poll, terminal poll included, with the raw body', async () => {
  statusReplies(
    { status: 'running', n: 1 },
    { status: 'running', n: 2 },
    { status: 'completed', n: 3 },
  );
  const { onProgress, calls } = progressGate();

  await runJob(http(), { submit: submitJ1, mapResult: () => 'ok', pollIntervalMs: 0, onProgress });

  expect(calls.map((c) => (c as { n: number }).n)).toEqual([1, 2, 3]);
  expect(calls[2]).toEqual({ status: 'completed', n: 3 });
});

test('a status body that is not a JSON object is read as not-yet-terminal and polling continues', async () => {
  pool().intercept({ path: STATUS_PATH, method: 'GET' }).reply(200, '');
  statusReplies({ status: 'succeeded' });
  const { onProgress, calls } = progressGate();

  const result = await runJob(http(), {
    submit: submitJ1,
    mapResult: (terminal) => terminal.status,
    pollIntervalMs: 0,
    onProgress,
  });

  expect(result).toBe('succeeded');
  expect(calls).toEqual([{}, { status: 'succeeded' }]);
});

// --- terminal detection through errors[] ---------------------------------------------

test('an output-level error while status still reads running is terminal → job_failed with redacted .items', async () => {
  statusReplies({
    jobId: 'j1',
    status: 'running',
    createdDate: CREATED,
    outputs: [
      { startedDate: at(1), completedDate: at(3) },
      {
        startedDate: at(1),
        errors: [
          {
            code: 'RENDER_FAILED',
            message: 'bad asset',
            source: 'https://x.blob.core.windows.net/f?sv=2021&sig=SUPER_SECRET',
          },
        ],
      },
    ],
  });

  const job = runJob(http(), { submit: submitJ1, mapResult: () => 'unreached', pollIntervalMs: 0 });
  const err = await rejectionOf(job);

  expect(err).toBeInstanceOf(AudioVideoError);
  expect(err?.code).toBe('job_failed');
  expect(err?.jobId).toBe('j1');
  expect(err?.items).toEqual([
    {
      index: 1,
      errors: [
        {
          code: 'RENDER_FAILED',
          message: 'bad asset',
          source: 'https://x.blob.core.windows.net/f',
        },
      ],
    },
  ]);
  expect(err?.message).toContain('output 1');
  for (const s of [JSON.stringify(err), String(err), inspect(err), err?.message]) {
    expect(s).not.toContain('SUPER_SECRET');
    expect(s).not.toContain('sig=');
  }
  // Timing is still derived from a failed terminal body.
  expect(job.meta?.perItem[0]?.renderMs).toBe(2_000);
  expect(agent.pendingInterceptors()).toHaveLength(0);
});

test('job-level errors while status still reads running are terminal → job_failed with an index-less item', async () => {
  statusReplies({ status: 'running', errors: [{ code: 'QUOTA_EXCEEDED' }] });

  const err = await rejectionOf(
    runJob(http(), { submit: submitJ1, mapResult: () => 'unreached', pollIntervalMs: 0 }),
  );

  expect(err?.code).toBe('job_failed');
  expect(err?.jobId).toBe('j1');
  expect(err?.items).toEqual([{ errors: [{ code: 'QUOTA_EXCEEDED' }] }]);
  expect(err?.message).toContain('job-level errors');
});

test('several failing outputs each get their own item, and the message names every index', async () => {
  statusReplies({
    status: 'running',
    outputs: [{ errors: [{ code: 'A' }] }, {}, { errors: [{ code: 'C' }, { code: 'D' }] }],
  });

  const err = await rejectionOf(
    runJob(http(), { submit: submitJ1, mapResult: () => 'unreached', pollIntervalMs: 0 }),
  );

  expect(err?.code).toBe('job_failed');
  expect(err?.items).toEqual([
    { index: 0, errors: [{ code: 'A' }] },
    { index: 2, errors: [{ code: 'C' }, { code: 'D' }] },
  ]);
  expect(err?.message).toContain('outputs 0, 2');
});

test('a null entry in outputs[] contributes no errors and no timing, and its neighbours keep their indices', async () => {
  statusReplies({
    jobId: 'j1',
    status: 'running',
    outputs: [null, { errors: [{ code: 'A' }] }],
  });

  const err = await rejectionOf(
    runJob(http(), { submit: submitJ1, mapResult: () => 'unreached', pollIntervalMs: 0 }),
  );

  expect(err?.code).toBe('job_failed');
  expect(err?.items).toEqual([{ index: 1, errors: [{ code: 'A' }] }]);
  expect(err?.message).toContain('output 1');

  const meta = parseTimings({
    jobId: 'j1',
    createdDate: CREATED,
    outputs: [null as unknown as JobItemLike, { startedDate: at(1), completedDate: at(3) }],
  });
  expect(meta.perItem).toEqual([
    { index: 0, queueMs: undefined, renderMs: undefined, totalMs: undefined },
    { index: 1, queueMs: 1_000, renderMs: 2_000, totalMs: 3_000 },
  ]);
  expect(meta.renderMs).toBe(2_000);
});

test('an onProgress that throws on the terminal poll rejects the job with that error, meta already derived', async () => {
  statusReplies(
    { status: 'running' },
    {
      jobId: 'j1',
      status: 'completed',
      createdDate: CREATED,
      outputs: [{ startedDate: at(1), completedDate: at(3) }],
    },
  );
  const bug = new RangeError('callback bug');
  const job = runJob(http(), {
    submit: submitJ1,
    mapResult: () => 'unreached',
    pollIntervalMs: 0,
    onProgress: (status) => {
      if (status.status === 'completed') throw bug;
    },
  });

  expect(await rejectionOf(job)).toBe(bug);
  expect(job.meta?.renderMs).toBe(2_000);
  expect(inspect(job)).toBe("{ jobId: 'j1', state: 'rejected' }");
});

test('the outcome is derived before onProgress sees the body, so mutating it there changes nothing', async () => {
  statusReplies({ status: 'completed' });
  const job = runJob(http(), {
    submit: submitJ1,
    mapResult: () => 'done',
    pollIntervalMs: 0,
    onProgress: (status) => {
      status.errors = [{ code: 'INJECTED' }];
    },
  });

  expect(await job).toBe('done');
  expect(job.meta).toBeDefined();
});

test('status "failed" with no error detail → job_failed with empty items', async () => {
  statusReplies({ status: 'failed' });

  const err = await rejectionOf(
    runJob(http(), { submit: submitJ1, mapResult: () => 'unreached', pollIntervalMs: 0 }),
  );

  expect(err?.code).toBe('job_failed');
  expect(err?.items).toEqual([]);
  expect(err?.message).toContain('"failed"');
});

test('status "canceled" reported by the service → rejects cancelled', async () => {
  statusReplies({ status: 'canceled' });
  const job = runJob(http(), { submit: submitJ1, mapResult: () => 'unreached', pollIntervalMs: 0 });

  const err = await rejectionOf(job);

  expect(err?.code).toBe('cancelled');
  expect(err?.jobId).toBe('j1');
  expect(inspect(job)).toBe("{ jobId: 'j1', state: 'cancelled' }");
});

// --- timing --------------------------------------------------------------------------

test('parseTimings: ms createdDate + 9-fractional-digit completedDate → finite queue/render/total', () => {
  const meta = parseTimings({
    jobId: 'j1',
    createdDate: CREATED,
    outputs: [{ startedDate: at(2.5), completedDate: at(12, '.123456789') }],
  });

  expect(meta).toEqual({
    jobId: 'j1',
    createdAt: Date.parse(CREATED),
    queueMs: 2_500,
    renderMs: 9_623,
    totalMs: 12_123,
    perItem: [{ index: 0, queueMs: 2_500, renderMs: 9_623, totalMs: 12_123 }],
  });
});

test('parseTimings: missing or unparseable dates → undefined metrics, never NaN', () => {
  const missing = parseTimings({ jobId: 'j1', outputs: [{}] });
  expect(missing).toEqual({
    jobId: 'j1',
    createdAt: undefined,
    queueMs: undefined,
    renderMs: undefined,
    totalMs: undefined,
    perItem: [{ index: 0, queueMs: undefined, renderMs: undefined, totalMs: undefined }],
  });

  const garbage = parseTimings(
    {
      createdDate: 'yesterday-ish',
      outputs: [{ startedDate: 'not a date', completedDate: at(12) }],
    },
    'j1',
  );
  expect(garbage.jobId).toBe('j1');
  expect(garbage.createdAt).toBeUndefined();
  expect(garbage.queueMs).toBeUndefined();
  expect(garbage.renderMs).toBeUndefined();
  expect(garbage.totalMs).toBeUndefined();

  const everyMetric = [missing, garbage].flatMap((m) => [
    m.createdAt,
    m.queueMs,
    m.renderMs,
    m.totalMs,
    ...m.perItem.flatMap((i) => [i.queueMs, i.renderMs, i.totalMs]),
  ]);
  expect(everyMetric.some((n) => Number.isNaN(n))).toBe(false);

  expect(parseTimings({})).toEqual({
    jobId: '',
    createdAt: undefined,
    queueMs: undefined,
    renderMs: undefined,
    totalMs: undefined,
    perItem: [],
  });
});

test('parseTimings: job-level spans the earliest start to the latest completion across outputs', () => {
  const meta = parseTimings({
    jobId: 'j1',
    createdDate: CREATED,
    outputs: [
      { startedDate: at(5), completedDate: at(20) },
      { startedDate: at(2), completedDate: at(9) },
      { startedDate: at(3) },
      { completedDate: at(4) },
    ],
  });

  expect(meta.queueMs).toBe(2_000);
  expect(meta.renderMs).toBe(18_000);
  expect(meta.totalMs).toBe(20_000);
  expect(meta.perItem).toEqual([
    { index: 0, queueMs: 5_000, renderMs: 15_000, totalMs: 20_000 },
    { index: 1, queueMs: 2_000, renderMs: 7_000, totalMs: 9_000 },
    { index: 2, queueMs: 3_000, renderMs: undefined, totalMs: undefined },
    { index: 3, queueMs: undefined, renderMs: undefined, totalMs: 4_000 },
  ]);
});

// --- cancel --------------------------------------------------------------------------

test('cancel(): stops polling, PUTs the cancel path, swallows its 500, rejects cancelled; a repeat is a no-op', async () => {
  const polls = runningForever();
  const cancels = cancelEndpoint(500);
  const { onProgress, first } = progressGate();
  const job = runJob(http(), {
    submit: submitJ1,
    mapResult: () => 'unreached',
    pollIntervalMs: 60_000,
    onProgress,
  });
  await first;
  expect(job.jobId).toBe('j1');
  expect(job.meta).toBeUndefined();
  expect(inspect(job)).toBe("{ jobId: 'j1', state: 'pending' }");

  await job.cancel();
  expect(cancels()).toBe(1);

  const err = await rejectionOf(job);
  expect(err).toBeInstanceOf(AudioVideoError);
  expect(err?.code).toBe('cancelled');
  expect(err?.jobId).toBe('j1');
  expect(err?.cause).toBeUndefined();
  expect(job.meta).toBeUndefined();
  expect(inspect(job)).toBe("{ jobId: 'j1', state: 'cancelled' }");

  await job.cancel();
  expect(cancels()).toBe(1);
  expect(polls()).toBe(1);
});

test('cancel() on a settled job is a no-op — no cancel request is issued', async () => {
  statusReplies({ status: 'completed' });
  const cancels = cancelEndpoint();
  const job = runJob(http(), { submit: submitJ1, mapResult: () => 'done', pollIntervalMs: 0 });
  await job;

  await job.cancel();

  expect(cancels()).toBe(0);
  expect(inspect(job)).toBe("{ jobId: 'j1', state: 'fulfilled' }");
});

test('cancel() while the submit is in flight rejects cancelled at once, lets the submit finish, then issues exactly one cancel request', async () => {
  const polls = runningForever();
  const cancels = cancelEndpoint();
  let releaseSubmit!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSubmit = resolve;
  });
  const submit = vi.fn(async () => {
    await gate;
    return { jobId: 'j1', statusUrl: STATUS_URL };
  });
  const job = runJob(http(), { submit, mapResult: () => 'unreached', pollIntervalMs: 0 });

  const cancelled = job.cancel();
  let cancelSettled = false;
  void cancelled.then(() => {
    cancelSettled = true;
  });
  expect(await isPending(job)).toBe(false);
  const err = await rejectionOf(job);
  expect(err?.code).toBe('cancelled');
  expect(job.jobId).toBeUndefined();
  await flush();
  expect(cancelSettled).toBe(false);
  expect(cancels()).toBe(0);

  releaseSubmit();
  await cancelled;

  expect(cancels()).toBe(1);
  expect(job.jobId).toBe('j1');
  expect(submit).toHaveBeenCalledTimes(1);
  expect(polls()).toBe(0);
  expect(inspect(job)).toBe("{ jobId: 'j1', state: 'cancelled' }");
});

test('cancel() during a real submit request leaves that request to complete and cancels the job it accepted', async () => {
  vi.useFakeTimers();
  pool()
    .intercept({ path: '/v1/templates/render', method: 'POST' })
    .reply(202, { jobId: 'j1', statusUrl: STATUS_URL })
    .delay(300);
  const polls = runningForever();
  const cancels = cancelEndpoint();
  const client = http();
  const job = runJob(client, {
    submit: () =>
      client
        .request<JobSubmission>('POST', '/v1/templates/render', { source: { url: 'https://x/y' } })
        .then((res) => res.body),
    mapResult: () => 'unreached',
  });

  await vi.advanceTimersByTimeAsync(20);
  const cancelled = job.cancel();
  const err = await rejectionOf(job);
  expect(err?.code).toBe('cancelled');
  expect(job.jobId).toBeUndefined();
  expect(cancels()).toBe(0);

  await vi.advanceTimersByTimeAsync(280); // the delayed 202 lands
  await cancelled;
  expect(job.jobId).toBe('j1');
  expect(cancels()).toBe(1);
  expect(polls()).toBe(0);
  expect(agent.pendingInterceptors().filter((i) => i.method === 'POST')).toHaveLength(0);
});

test('a submit that fails while a cancel is waiting on it resolves the cancel with no cancel request', async () => {
  const cancels = cancelEndpoint();
  const failure = new AudioVideoError({
    message: 'Request failed with status 400.',
    code: 'http_400',
  });
  let failSubmit!: () => void;
  const submit = vi.fn(
    () =>
      new Promise<JobSubmission>((_, reject) => {
        failSubmit = () => reject(failure);
      }),
  );
  const job = runJob(http(), { submit, mapResult: () => 'unreached' });

  const cancelled = job.cancel();
  expect((await rejectionOf(job))?.code).toBe('cancelled');
  failSubmit();
  await cancelled;

  expect(cancels()).toBe(0);
  expect(job.jobId).toBeUndefined();
  expect(inspect(job)).toBe("{ jobId: undefined, state: 'cancelled' }");
});

test('cancel() while the submit is in flight still rejects cancelled, not submit_failed, even once the submit later rejects with a raw error', async () => {
  const cancels = cancelEndpoint();
  let failSubmit!: () => void;
  const submit = vi.fn(
    () =>
      new Promise<JobSubmission>((_, reject) => {
        failSubmit = () => reject(new TypeError('fetch failed'));
      }),
  );
  const job = runJob(http(), { submit, mapResult: () => 'unreached' });

  const cancelled = job.cancel();
  expect((await rejectionOf(job))?.code).toBe('cancelled');
  failSubmit();
  await cancelled;

  expect(cancels()).toBe(0);
  expect(job.jobId).toBeUndefined();
  expect(inspect(job)).toBe("{ jobId: undefined, state: 'cancelled' }");
});

test('an external signal abort cancels the job the same way, with the abort reason as cause', async () => {
  const polls = runningForever();
  const cancels = cancelEndpoint();
  const { onProgress, first } = progressGate();
  const controller = new AbortController();
  const reason = new Error('caller gave up');
  const job = runJob(http(), {
    submit: submitJ1,
    mapResult: () => 'unreached',
    pollIntervalMs: 60_000,
    onProgress,
    signal: controller.signal,
  });
  await first;

  controller.abort(reason);

  const err = await rejectionOf(job);
  expect(err?.code).toBe('cancelled');
  expect(err?.jobId).toBe('j1');
  expect(err?.cause).toBe(reason);
  await vi.waitFor(() => expect(cancels()).toBe(1));
  expect(polls()).toBe(1);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});

/** A status endpoint that holds its answer until released; `arrived` turns true once a poll reaches it. */
function heldStatus(): { arrived: () => boolean; release: () => void } {
  const held = deferred();
  let arrived = false;
  pool()
    .intercept({ path: STATUS_PATH, method: 'GET' })
    .reply(200, async () => {
      arrived = true;
      await held.promise;
      return { jobId: 'j1', status: 'running' };
    });
  return { arrived: () => arrived, release: held.resolve };
}

test("cancel() while a status poll is in flight rejects with the job's own cancelled error, not the request's", async () => {
  const status = heldStatus();
  const cancels = cancelEndpoint();
  const job = runJob(http(), { submit: submitJ1, mapResult: () => 'unreached' });
  await until(status.arrived);

  await job.cancel();
  const err = await rejectionOf(job);
  status.release();

  expect(err?.code).toBe('cancelled');
  expect(err?.message).toBe('Job j1 was cancelled.');
  expect(err?.jobId).toBe('j1');
  expect(err?.cause).toBeUndefined();
  expect(cancels()).toBe(1);
});

test('timeoutMs elapsing while a status poll is in flight rejects job_timeout', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const status = heldStatus();
  const job = runJob(http(), { submit: submitJ1, mapResult: () => 'unreached', timeoutMs: 5_000 });
  const settled = rejectionOf(job);
  await until(status.arrived);

  await vi.advanceTimersByTimeAsync(5_000);
  const err = await settled;
  status.release();

  expect(err?.code).toBe('job_timeout');
  expect(err?.jobId).toBe('j1');
});

test('a status poll that runs past the per-attempt timeout is retried, and the job resolves once a poll answers', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const attemptTimeouts: AbortController[] = [];
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const controller = new AbortController();
    attemptTimeouts.push(controller);
    return controller.signal;
  });
  try {
    const status = heldStatus();
    statusReplies({ status: 'completed' });
    const { client, gets } = countingHttp();
    const job = runJob(client, { submit: submitJ1, mapResult: () => 'done', pollIntervalMs: 0 });
    const settled = rejectionOf(job);
    await until(status.arrived);

    attemptTimeouts.at(-1)?.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    await vi.advanceTimersByTimeAsync(1_000); // the first retry's 1 s wait
    status.release();

    expect(await settled).toBeUndefined();
    expect(await job).toBe('done');
    expect(gets()).toBe(2);
  } finally {
    timeout.mockRestore();
  }
});

test('a statusUrl on another origin is never polled: the job rejects invalid_response', async () => {
  let polled = 0;
  agent
    .get('https://other-host.example')
    .intercept({ path: '/v1/status/j1', method: 'GET' })
    .reply(200, () => {
      polled += 1;
      return { status: 'completed' };
    })
    .persist();
  const job = runJob(http(), {
    submit: () =>
      Promise.resolve({ jobId: 'j1', statusUrl: 'https://other-host.example/v1/status/j1' }),
    mapResult: () => 'unreached',
  });

  const err = await rejectionOf(job);

  expect(err?.code).toBe('invalid_response');
  expect(polled).toBe(0);
});

test('the listener on the caller signal is detached when the job settles without that signal aborting', async () => {
  const polls = runningForever();
  cancelEndpoint();
  const { onProgress, first } = progressGate();
  const controller = new AbortController();
  const job = runJob(http(), {
    submit: submitJ1,
    mapResult: () => 'unreached',
    pollIntervalMs: 60_000,
    onProgress,
    signal: controller.signal,
  });
  await first;
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);

  await job.cancel();
  expect((await rejectionOf(job))?.code).toBe('cancelled');

  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  expect(polls()).toBe(1);
});

test('an AudioVideoError thrown by the run passes through unmasked even when the signal aborted in the same instant', async () => {
  const external = new AbortController();
  const failure = new AudioVideoError({ message: 'x', code: 'http_500', status: 500 });
  const job = new AsyncJob<string>({
    run: () => {
      external.abort();
      return Promise.reject(failure);
    },
    cancelRemote: () => Promise.resolve(),
    signal: external.signal,
  });

  expect(await rejectionOf(job)).toBe(failure);
  expect(inspect(job)).toBe("{ jobId: undefined, state: 'rejected' }");
  await job.cancel();
});

test('an already-aborted external signal rejects cancelled without submitting or issuing a cancel request', async () => {
  const cancels = cancelEndpoint();
  const submit = vi.fn(submitJ1);
  const controller = new AbortController();
  const reason = new Error('never started');
  controller.abort(reason);

  const job = runJob(http(), { submit, mapResult: () => 'unreached', signal: controller.signal });

  const err = await rejectionOf(job);
  expect(err?.code).toBe('cancelled');
  expect(err?.cause).toBe(reason);
  expect(err?.jobId).toBeUndefined();
  expect(submit).not.toHaveBeenCalled();
  await job.cancel();
  await flush();
  expect(cancels()).toBe(0);
  expect(inspect(job)).toBe("{ jobId: undefined, state: 'cancelled' }");
});

// --- polling cadence + timeout (fake timers) -------------------------------------------

test('the default poll interval steps 1 s → 2 s → 5 s', async () => {
  vi.useFakeTimers();
  const polls = runningForever();
  cancelEndpoint();
  const { onProgress, first } = progressGate();
  const job = runJob(http(), { submit: submitJ1, mapResult: () => 'unreached', onProgress });
  await first;
  expect(polls()).toBe(1);

  await vi.advanceTimersByTimeAsync(999);
  expect(polls()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(polls()).toBe(2); // t = 1 s
  await vi.advanceTimersByTimeAsync(29_000);
  expect(polls()).toBe(31); // t = 30 s — the last poll of the 1 s tier
  await vi.advanceTimersByTimeAsync(1_999);
  expect(polls()).toBe(31); // t = 31.999 s
  await vi.advanceTimersByTimeAsync(1);
  expect(polls()).toBe(32); // t = 32 s — the 2 s tier
  await vi.advanceTimersByTimeAsync(88_000);
  expect(polls()).toBe(76); // t = 120 s — the last poll of the 2 s tier
  await vi.advanceTimersByTimeAsync(4_999);
  expect(polls()).toBe(76); // t = 124.999 s
  await vi.advanceTimersByTimeAsync(1);
  expect(polls()).toBe(77); // t = 125 s — the 5 s tier

  await job.cancel();
  expect((await rejectionOf(job))?.code).toBe('cancelled');
});

test('a numeric pollIntervalMs is used as-is', async () => {
  vi.useFakeTimers();
  const polls = runningForever();
  cancelEndpoint();
  const { onProgress, first } = progressGate();
  const job = runJob(http(), {
    submit: submitJ1,
    mapResult: () => 'unreached',
    pollIntervalMs: 500,
    onProgress,
  });
  await first;

  await vi.advanceTimersByTimeAsync(499);
  expect(polls()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(polls()).toBe(2);
  await vi.advanceTimersByTimeAsync(500);
  expect(polls()).toBe(3);

  await job.cancel();
  expect((await rejectionOf(job))?.code).toBe('cancelled');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(polls()).toBe(3);
  expect(vi.getTimerCount()).toBe(0);
});

test('an interval function returning a non-finite value falls back to the default tier, never a zero-delay loop', async () => {
  vi.useFakeTimers();
  const polls = runningForever();
  cancelEndpoint();
  const { onProgress, first } = progressGate();
  const job = runJob(http(), {
    submit: submitJ1,
    mapResult: () => 'unreached',
    pollIntervalMs: () => Number.NaN,
    onProgress,
  });
  await first;

  await vi.advanceTimersByTimeAsync(999);
  expect(polls()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(polls()).toBe(2);

  await job.cancel();
  expect((await rejectionOf(job))?.code).toBe('cancelled');
});

test('timeoutMs → rejects job_timeout, stops polling, and issues no cancel request', async () => {
  vi.useFakeTimers();
  const polls = runningForever();
  const cancels = cancelEndpoint();
  const { onProgress, first } = progressGate();
  const job = runJob(http(), {
    submit: submitJ1,
    mapResult: () => 'unreached',
    timeoutMs: 2_500,
    onProgress,
  });
  await first;

  await vi.advanceTimersByTimeAsync(2_499);
  expect(polls()).toBe(3); // t = 0, 1 s, 2 s
  expect(await isPending(job)).toBe(true);

  await vi.advanceTimersByTimeAsync(1);
  const err = await rejectionOf(job);
  expect(err).toBeInstanceOf(AudioVideoError);
  expect(err?.code).toBe('job_timeout');
  expect(err?.jobId).toBe('j1');
  expect(err?.message).toContain('2500 ms');
  expect(err?.message).toContain('not asked to stop');

  await vi.advanceTimersByTimeAsync(60_000);
  expect(polls()).toBe(3);
  expect(cancels()).toBe(0);
  expect(inspect(job)).toBe("{ jobId: 'j1', state: 'rejected' }");
  expect(vi.getTimerCount()).toBe(0);
});

test('a job that completes within timeoutMs leaves no timer armed', async () => {
  vi.useFakeTimers();
  statusReplies({ status: 'completed' });
  const job = runJob(http(), { submit: submitJ1, mapResult: () => 'done', timeoutMs: 60_000 });

  expect(await job).toBe('done');
  expect(vi.getTimerCount()).toBe(0);
});

test('cancelOnTimeout: true → timeoutMs still rejects job_timeout, and the cancel request is issued', async () => {
  vi.useFakeTimers();
  const polls = runningForever();
  const cancels = cancelEndpoint();
  const { onProgress, first } = progressGate();
  const job = runJob(http(), {
    submit: submitJ1,
    mapResult: () => 'unreached',
    timeoutMs: 2_500,
    cancelOnTimeout: true,
    onProgress,
  });
  await first;
  const settled = rejectionOf(job);

  await vi.advanceTimersByTimeAsync(2_500);
  const err = await settled;
  expect(err?.code).toBe('job_timeout');
  expect(err?.jobId).toBe('j1');
  expect(err?.message).toContain('cancel request');
  await vi.waitFor(() => expect(cancels()).toBe(1));

  await vi.advanceTimersByTimeAsync(60_000);
  expect(polls()).toBe(3);
  expect(cancels()).toBe(1);
  expect(inspect(job)).toBe("{ jobId: 'j1', state: 'rejected' }");
});

// --- request failures ----------------------------------------------------------------

test('a rejected submit rejects the job with that same error, without a second submit; jobId and meta stay undefined', async () => {
  const failure = new AudioVideoError({
    message: 'Request failed with status 400.',
    code: 'http_400',
    status: 400,
  });
  const submit = vi.fn(() => Promise.reject(failure));
  const job = runJob(http(), { submit, mapResult: () => 'unreached' });

  expect(await rejectionOf(job)).toBe(failure);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(job.jobId).toBeUndefined();
  expect(job.meta).toBeUndefined();
  expect(inspect(job)).toBe("{ jobId: undefined, state: 'rejected' }");
});

test('a submit rejecting with something other than AudioVideoError is wrapped submit_failed, keeping it as .cause', async () => {
  const cause = new TypeError('fetch failed');
  const submit = vi.fn(() => Promise.reject(cause));
  const job = runJob(http(), { submit, mapResult: () => 'unreached' });

  const err = await rejectionOf(job);
  expect(err?.code).toBe('submit_failed');
  expect(err?.cause).toBe(cause);
  expect(err?.jobId).toBeUndefined();
  expect(submit).toHaveBeenCalledTimes(1);
  expect(job.jobId).toBeUndefined();
  expect(job.meta).toBeUndefined();
  expect(inspect(job)).toBe("{ jobId: undefined, state: 'rejected' }");
});

test("a TokenProvider's plain Error rejecting the submit is wrapped submit_failed the same way", async () => {
  const cause = new Error('token endpoint unreachable');
  const submit = vi.fn(() => Promise.reject(cause));
  const job = runJob(http(), { submit, mapResult: () => 'unreached' });

  const err = await rejectionOf(job);
  expect(err?.code).toBe('submit_failed');
  expect(err?.cause).toBe(cause);
});

// --- transient status-poll failures ------------------------------------------------------

test('a 503 on a poll is retried after 1 s, reporting no progress, and the job resolves once the next polls answer', async () => {
  vi.useFakeTimers();
  pool().intercept({ path: STATUS_PATH, method: 'GET' }).reply(503, { error: 'unavailable' });
  statusReplies({ status: 'running' }, { status: 'completed' });
  const { client, gets } = countingHttp();
  const { onProgress, calls } = progressGate();
  const job = runJob(client, { submit: submitJ1, mapResult: () => 'done', onProgress });

  await vi.advanceTimersByTimeAsync(999);
  expect(gets()).toBe(1);
  expect(calls).toEqual([]);
  expect(inspect(job)).toBe("{ jobId: 'j1', state: 'pending' }");

  await vi.advanceTimersByTimeAsync(1); // the retry, at t = 1 s
  expect(gets()).toBe(2);
  expect(calls).toEqual([{ status: 'running' }]);

  await vi.advanceTimersByTimeAsync(1_000); // the regular 1 s tier resumes
  expect(await job).toBe('done');
  expect(gets()).toBe(3);
  expect(calls).toEqual([{ status: 'running' }, { status: 'completed' }]);
  expect(agent.pendingInterceptors()).toHaveLength(0);
});

test('a transport error on a poll is retried and the job resolves once the next poll answers', async () => {
  vi.useFakeTimers();
  pool().intercept({ path: STATUS_PATH, method: 'GET' }).replyWithError(new Error('ECONNRESET'));
  statusReplies({ status: 'completed' });
  const { client, gets } = countingHttp();
  const job = runJob(client, { submit: submitJ1, mapResult: () => 'done', pollIntervalMs: 0 });

  await vi.advanceTimersByTimeAsync(1_000);
  expect(await job).toBe('done');
  expect(gets()).toBe(2);
  expect(agent.pendingInterceptors()).toHaveLength(0);
});

test('five consecutive 503s exhaust the default budget → job_poll_failed carrying the last failure, with no cancel request', async () => {
  vi.useFakeTimers();
  const { polls } = failingForever(503);
  const cancels = cancelEndpoint();
  const job = runJob(http(), { submit: submitJ1, mapResult: () => 'unreached' });
  const settled = rejectionOf(job);

  await vi.advanceTimersByTimeAsync(15_000); // 1 + 2 + 4 + 8 s of backoff
  expect(polls()).toBe(5);
  expect(await isPending(job)).toBe(false);
  const err = await settled;
  expect(err).toBeInstanceOf(AudioVideoError);
  expect(err?.code).toBe('job_poll_failed');
  expect(err?.jobId).toBe('j1');
  expect(err?.status).toBe(503);
  expect(err?.items).toEqual([{ error: 'status 503' }]);
  expect(err?.cause).toBeInstanceOf(AudioVideoError);
  expect((err?.cause as AudioVideoError).code).toBe('http_503');
  expect(err?.message).toContain('after 5 failed polls');
  expect(err?.message).toContain('HTTP 503');
  expect(err?.message).toContain('may still complete');
  expect(inspect(job)).toBe("{ jobId: 'j1', state: 'rejected' }");

  await vi.advanceTimersByTimeAsync(60_000);
  expect(polls()).toBe(5);
  expect(cancels()).toBe(0);
});

test.each([403, 404])(
  'a %i on a poll is final: the job rejects with that HTTP error after exactly one request',
  async (status) => {
    const { polls } = failingForever(status);
    const cancels = cancelEndpoint();
    const job = runJob(http(), {
      submit: submitJ1,
      mapResult: () => 'unreached',
      pollIntervalMs: 0,
    });

    const err = await rejectionOf(job);

    expect(err).toBeInstanceOf(AudioVideoError);
    expect(err?.code).toBe(`http_${status}`);
    expect(err?.status).toBe(status);
    expect(polls()).toBe(1);
    expect(cancels()).toBe(0);
    expect(inspect(job)).toBe("{ jobId: 'j1', state: 'rejected' }");
  },
);

test('cancel() during a retry backoff rejects cancelled at once, issues the cancel request, and polls no further', async () => {
  vi.useFakeTimers();
  const { polls } = failingForever(503);
  const cancels = cancelEndpoint();
  const job = runJob(http(), { submit: submitJ1, mapResult: () => 'unreached' });

  await vi.advanceTimersByTimeAsync(500);
  expect(polls()).toBe(1);
  expect(await isPending(job)).toBe(true);

  await job.cancel();
  const err = await rejectionOf(job);
  expect(err?.code).toBe('cancelled');
  expect(err?.jobId).toBe('j1');
  expect(cancels()).toBe(1);

  await vi.advanceTimersByTimeAsync(60_000);
  expect(polls()).toBe(1);
});

test('timeoutMs elapsing during a retry backoff rejects job_timeout and polls no further', async () => {
  vi.useFakeTimers();
  const { polls } = failingForever(503);
  const cancels = cancelEndpoint();
  const job = runJob(http(), { submit: submitJ1, mapResult: () => 'unreached', timeoutMs: 500 });
  const settled = rejectionOf(job);

  await vi.advanceTimersByTimeAsync(499);
  expect(polls()).toBe(1);
  expect(await isPending(job)).toBe(true);

  await vi.advanceTimersByTimeAsync(1);
  const err = await settled;
  expect(err?.code).toBe('job_timeout');
  expect(err?.jobId).toBe('j1');

  await vi.advanceTimersByTimeAsync(60_000);
  expect(polls()).toBe(1);
  expect(cancels()).toBe(0);
});

test('the failure budget counts consecutive failures only: six 503s each followed by a good poll still resolve', async () => {
  vi.useFakeTimers();
  const script: Array<number | object> = [];
  for (let i = 0; i < 6; i += 1) script.push(503, { status: 'running' });
  script.push({ status: 'completed' });
  const polls = scriptedStatus(...script);
  const job = runJob(http(), { submit: submitJ1, mapResult: () => 'done' });

  await vi.advanceTimersByTimeAsync(12_000); // every wait is 1 s: the retry floor equals the 1 s tier
  expect(await job).toBe('done');
  expect(polls()).toBe(13);
});

test('retries wait 1 s, 2 s, 4 s, then 8 s between consecutive failed polls', async () => {
  vi.useFakeTimers();
  const { polls, times } = failingForever(503);
  const job = runJob(http(), { submit: submitJ1, mapResult: () => 'unreached' });
  const settled = rejectionOf(job);

  await vi.advanceTimersByTimeAsync(15_000);
  expect((await settled)?.code).toBe('job_poll_failed');
  const start = times[0] ?? 0;
  expect(times.map((t) => t - start)).toEqual([0, 1_000, 3_000, 7_000, 15_000]);
  expect(polls()).toBe(5);
});

test('a retry never waits less than the poll interval due at that moment', async () => {
  vi.useFakeTimers();
  const { times } = failingForever(503);
  const job = runJob(http(), {
    submit: submitJ1,
    mapResult: () => 'unreached',
    pollIntervalMs: 3_000,
  });
  const settled = rejectionOf(job);

  await vi.advanceTimersByTimeAsync(18_000);
  expect((await settled)?.code).toBe('job_poll_failed');
  const start = times[0] ?? 0;
  expect(times.map((t) => t - start)).toEqual([0, 3_000, 6_000, 10_000, 18_000]);
});

test('a retry never waits more than 30 s', async () => {
  vi.useFakeTimers();
  const { times } = failingForever(503);
  const job = runJob(http(), {
    submit: submitJ1,
    mapResult: () => 'unreached',
    pollIntervalMs: 45_000,
    maxPollFailures: 2,
  });
  const settled = rejectionOf(job);

  await vi.advanceTimersByTimeAsync(30_000);
  expect((await settled)?.code).toBe('job_poll_failed');
  const start = times[0] ?? 0;
  expect(times.map((t) => t - start)).toEqual([0, 30_000]);
});

test('maxPollFailures: 1 rejects job_poll_failed on the first failed poll, carrying that HTTP error', async () => {
  const { polls } = failingForever(500);
  const job = runJob(http(), {
    submit: submitJ1,
    mapResult: () => 'unreached',
    pollIntervalMs: 0,
    maxPollFailures: 1,
  });

  const err = await rejectionOf(job);

  expect(err?.code).toBe('job_poll_failed');
  expect(err?.status).toBe(500);
  expect(err?.jobId).toBe('j1');
  expect((err?.cause as AudioVideoError).code).toBe('http_500');
  expect(err?.message).toContain('after 1 failed poll (last failure: HTTP 500)');
  expect(polls()).toBe(1);
});

test.each([0, -3, 2.5, Number.NaN])(
  'maxPollFailures %p is not an integer of at least 1, so the default applies',
  async (maxPollFailures) => {
    vi.useFakeTimers();
    const { polls } = failingForever(503);
    const job = runJob(http(), { submit: submitJ1, mapResult: () => 'unreached', maxPollFailures });
    const settled = rejectionOf(job);

    await vi.advanceTimersByTimeAsync(15_000);
    expect((await settled)?.code).toBe('job_poll_failed');
    expect(polls()).toBe(DEFAULT_MAX_POLL_FAILURES);
  },
);

// --- inspectability + neutrality -------------------------------------------------------

test('util.inspect prints only { jobId, state } — never the status URL or host', async () => {
  const polls = runningForever();
  cancelEndpoint();
  const { onProgress, first } = progressGate();
  const job = runJob(http(), {
    submit: submitJ1,
    mapResult: () => 'unreached',
    pollIntervalMs: 60_000,
    onProgress,
  });
  expect(inspect(job)).toBe("{ jobId: undefined, state: 'pending' }");

  await first;
  const printed = inspect(job);
  expect(printed).toBe("{ jobId: 'j1', state: 'pending' }");
  expect(printed).not.toContain('/v1/status');
  expect(printed).not.toContain('adobe.io');

  await job.cancel();
  expect((await rejectionOf(job))?.code).toBe('cancelled');
  expect(polls()).toBe(1);
});

test('the dgr JobStatusResponse satisfies JobStatusLike structurally, while core/job.ts imports nothing from dgr/', () => {
  const dgrStatus: JobStatusResponse = {
    jobId: 'j1',
    status: 'running',
    createdDate: CREATED,
    totalJobItems: 1,
    outputs: [{ startedDate: at(1), destination: { url: 'https://out.example/f.mov' } }],
  };
  const asLike: JobStatusLike = dgrStatus;
  expect(asLike).toBe(dgrStatus);

  const source = readFileSync(new URL('../src/core/job.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/from\s+['"][^'"]*dgr\//);
});
