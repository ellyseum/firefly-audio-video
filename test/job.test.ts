import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TokenProvider } from '../src/core/auth.js';
import { AudioVideoError } from '../src/core/errors.js';
import { DEFAULT_HOST, HttpClient } from '../src/core/http.js';
import { AsyncJob, parseTimings, runJob } from '../src/core/job.js';
import type { JobStatusLike } from '../src/core/job.js';
import type { JobStatusResponse } from '../src/dgr/types.js';

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

/** True iff `p` has NOT settled by the current microtask tick. */
async function isPending(p: PromiseLike<unknown>): Promise<boolean> {
  const sentinel = Symbol('still-pending');
  const settled = p.then(
    () => 'settled',
    () => 'settled',
  );
  return (await Promise.race([settled, Promise.resolve(sentinel)])) === sentinel;
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
    submit: (signal) =>
      client
        .request<{ jobId: string; statusUrl: string }>(
          'POST',
          '/v1/templates/render',
          { source: { url: 'https://x/y' } },
          { signal },
        )
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

test('cancel() before the submit response waits for the job ID, then issues the cancel request', async () => {
  const polls = runningForever();
  const cancels = cancelEndpoint();
  let releaseSubmit!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSubmit = resolve;
  });
  const submit = vi.fn(async (signal: AbortSignal) => {
    await gate;
    expect(signal.aborted).toBe(true);
    return { jobId: 'j1', statusUrl: STATUS_URL };
  });
  const job = runJob(http(), { submit, mapResult: () => 'unreached', pollIntervalMs: 0 });

  const cancelled = job.cancel();
  let cancelSettled = false;
  void cancelled.then(() => {
    cancelSettled = true;
  });
  await flush();
  expect(cancelSettled).toBe(false);
  expect(cancels()).toBe(0);

  releaseSubmit();
  await cancelled;

  expect(cancels()).toBe(1);
  const err = await rejectionOf(job);
  expect(err?.code).toBe('cancelled');
  expect(err?.jobId).toBe('j1');
  expect(polls()).toBe(0);
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

  await vi.advanceTimersByTimeAsync(60_000);
  expect(polls()).toBe(3);
  expect(cancels()).toBe(0);
  expect(inspect(job)).toBe("{ jobId: 'j1', state: 'rejected' }");
});

// --- request failures ----------------------------------------------------------------

test('a rejected submit rejects the job with that same error; jobId and meta stay undefined', async () => {
  const failure = new AudioVideoError({
    message: 'Request failed with status 400.',
    code: 'http_400',
    status: 400,
  });
  const job = runJob(http(), {
    submit: () => Promise.reject(failure),
    mapResult: () => 'unreached',
  });

  expect(await rejectionOf(job)).toBe(failure);
  expect(job.jobId).toBeUndefined();
  expect(job.meta).toBeUndefined();
  expect(inspect(job)).toBe("{ jobId: undefined, state: 'rejected' }");
});

test('a failing status poll rejects the job with the HTTP error', async () => {
  pool().intercept({ path: STATUS_PATH, method: 'GET' }).reply(500, { error: 'boom' });
  const job = runJob(http(), { submit: submitJ1, mapResult: () => 'unreached', pollIntervalMs: 0 });

  const err = await rejectionOf(job);

  expect(err?.code).toBe('http_500');
  expect(err?.status).toBe(500);
});

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
