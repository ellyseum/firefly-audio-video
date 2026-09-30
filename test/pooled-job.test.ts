import { getEventListeners } from 'node:events';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { AudioVideoError } from '../src/core/errors.js';
import { AsyncJob } from '../src/core/job.js';
import { InMemoryPool } from '../src/core/pool.js';
import { rejectedJob, runPooledJob, type PooledJobOutcome } from '../src/core/pooled-job.js';

const unhandledRejections: unknown[] = [];
const onUnhandledRejection = (reason: unknown): void => void unhandledRejections.push(reason);

beforeAll(() => {
  process.on('unhandledRejection', onUnhandledRejection);
});

afterAll(() => {
  process.off('unhandledRejection', onUnhandledRejection);
});

afterEach(async () => {
  await flush();
  expect(unhandledRejections.splice(0)).toEqual([]);
});

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A job that reports `jobId` at once and settles when `result` does, or when it is aborted. */
function controlledJob<T>(jobId: string, result: Promise<T>, cancels: string[] = []): AsyncJob<T> {
  return AsyncJob.start<T>({
    run: async (ctx) => {
      await ctx.trackSubmission(Promise.resolve({ jobId, statusUrl: `/v1/status/${jobId}` }));
      return new Promise<T>((resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
        result.then(resolve, reject);
      });
    },
    cancelRemote: async (id) => {
      cancels.push(id);
    },
  });
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

test('a call holds its slot from admission until its job settles, and a rejecting job releases it', async () => {
  const pool = new InMemoryPool({ concurrency: 1 });
  const first = deferred<string>();
  const a = runPooledJob({
    pool,
    prepare: () => () => controlledJob('job-a', first.promise),
    finish: (value) => value,
  });
  const started: string[] = [];
  const b = runPooledJob({
    pool,
    prepare: () => () => {
      started.push('b');
      return controlledJob('job-b', Promise.resolve('b-result'));
    },
    finish: (value) => value,
  });
  await flush();
  expect(pool.active).toBe(1);
  expect(pool.queued).toBe(1);
  expect(a.jobId).toBe('job-a');
  expect(started).toEqual([]);

  first.reject(new AudioVideoError({ message: 'boom', code: 'job_failed' }));
  expect((await rejection(a)).code).toBe('job_failed');
  await expect(b).resolves.toBe('b-result');
  expect(started).toEqual(['b']);
  await pool.drain();
  expect(pool.active).toBe(0);
});

test('a signal aborting while the call is queued rejects cancelled with the reason as cause, and the job never starts', async () => {
  const pool = new InMemoryPool({ concurrency: 1 });
  const hold = deferred<string>();
  const holder = runPooledJob({
    pool,
    prepare: () => () => controlledJob('job-a', hold.promise),
    finish: (value) => value,
  });
  const controller = new AbortController();
  let starts = 0;
  const queued = runPooledJob({
    pool,
    signal: controller.signal,
    prepare: () => () => {
      starts += 1;
      return controlledJob('job-b', Promise.resolve('never'));
    },
    finish: (value) => value,
  });
  await flush();
  expect(pool.queued).toBe(1);

  const reason = new Error('caller gave up');
  controller.abort(reason);
  const error = await rejection(queued);
  expect(error.code).toBe('cancelled');
  expect(error.cause).toBe(reason);

  hold.resolve('done');
  await holder;
  await pool.drain();
  expect(starts).toBe(0);
  expect(queued.jobId).toBeUndefined();
});

test('cancel() while the call is still preparing rejects at once; the pool is never asked for a slot', async () => {
  const pool = new InMemoryPool({ concurrency: 1 });
  const staging = deferred<() => AsyncJob<string>>();
  let starts = 0;
  const job = runPooledJob({
    pool,
    prepare: () => staging.promise,
    finish: (value) => value,
  });
  await flush();

  await job.cancel();
  expect((await rejection(job)).code).toBe('cancelled');

  staging.resolve(() => {
    starts += 1;
    return controlledJob('job-a', Promise.resolve('never'));
  });
  await flush();
  expect(starts).toBe(0);
  expect(pool.active).toBe(0);
  expect(pool.queued).toBe(0);
});

test('cancel() after the job starts delegates to the job, which asks the service to stop it', async () => {
  const pool = new InMemoryPool();
  const cancels: string[] = [];
  const never = new Promise<string>(() => undefined);
  const job = runPooledJob({
    pool,
    prepare: () => () => controlledJob('job-a', never, cancels),
    finish: (value) => value,
  });
  await flush();
  expect(job.jobId).toBe('job-a');

  await job.cancel();
  expect((await rejection(job)).code).toBe('cancelled');
  expect(cancels).toEqual(['job-a']);
  await pool.drain();
  expect(pool.active).toBe(0);
});

test('cancel() while finishing aborts the signal finish received', async () => {
  const pool = new InMemoryPool();
  const reachedFinish = deferred();
  const job = runPooledJob({
    pool,
    prepare: () => () => controlledJob('job-a', Promise.resolve('result')),
    finish: (_value, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        reachedFinish.resolve();
      }),
  });
  await reachedFinish.promise;
  expect(pool.active).toBe(0);

  await job.cancel();
  expect((await rejection(job)).code).toBe('cancelled');
});

test('a call that settles leaves no listener on the caller signal, on a Node without AbortSignal.any too', async () => {
  await withoutAbortSignalAny(async () => {
    const controller = new AbortController();
    let finishSignal: AbortSignal | undefined;
    const job = runPooledJob({
      pool: new InMemoryPool(),
      signal: controller.signal,
      prepare: () => () => controlledJob('job-a', Promise.resolve('raw')),
      finish: (value, signal) => {
        finishSignal = signal;
        return value;
      },
    });

    await expect(job).resolves.toBe('raw');
    expect(finishSignal).not.toBe(controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

test('a caller signal aborting while the call finishes aborts the finish signal, leaving no listener behind', async () => {
  await withoutAbortSignalAny(async () => {
    const controller = new AbortController();
    const reachedFinish = deferred();
    const job = runPooledJob({
      pool: new InMemoryPool(),
      signal: controller.signal,
      prepare: () => () => controlledJob('job-a', Promise.resolve('raw')),
      finish: (_value, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          reachedFinish.resolve();
        }),
    });
    await reachedFinish.promise;

    const reason = new Error('caller gave up');
    controller.abort(reason);
    await expect(job).rejects.toBe(reason);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

test('onSettle runs exactly once, after finish, and a throwing onSettle changes nothing', async () => {
  const outcomes: Array<PooledJobOutcome<string>> = [];
  const job = runPooledJob({
    pool: new InMemoryPool(),
    prepare: () => () => controlledJob('job-a', Promise.resolve('raw')),
    finish: (value) => `${value}-finished`,
    onSettle: (outcome, started) => {
      outcomes.push(outcome);
      expect(started?.jobId).toBe('job-a');
      throw new Error('a broken reporter');
    },
  });
  await expect(job).resolves.toBe('raw-finished');
  await flush();
  expect(outcomes).toEqual([{ ok: true, value: 'raw-finished' }]);
  expect(inspect(job)).toBe(inspect({ jobId: 'job-a', state: 'fulfilled' }));
});

test('a prepare that throws rejects the call without entering the pool', async () => {
  const pool = new InMemoryPool();
  const outcomes: unknown[] = [];
  const error = new AudioVideoError({ message: 'bad input', code: 'invalid_argument' });
  const job = runPooledJob<string, string>({
    pool,
    prepare: () => {
      throw error;
    },
    finish: (value) => value,
    onSettle: (outcome) => outcomes.push(outcome),
  });
  await expect(job).rejects.toBe(error);
  expect(outcomes).toEqual([{ ok: false, error }]);
  expect(pool.active).toBe(0);
});

test('rejectedJob rejects with its error, has no job ID or timing, and cancelling it is a no-op', async () => {
  const error = new AudioVideoError({ message: 'no client', code: 'invalid_argument' });
  const job = rejectedJob<string>(error);
  expect(job.jobId).toBeUndefined();
  expect(job.meta).toBeUndefined();
  await expect(job.cancel()).resolves.toBeUndefined();
  await expect(job).rejects.toBe(error);
  await expect(job.catch((reason: unknown) => reason)).resolves.toBe(error);
});
