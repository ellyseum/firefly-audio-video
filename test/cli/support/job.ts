/** {@link RenderJob}/{@link JobHandle} test doubles for `render`/`describe`. */

import { AudioVideoError } from '../../../src/core/errors.js';
import type { JobMeta } from '../../../src/core/job.js';
import type { RenderJob } from '../../../src/dgr/client.js';

interface JobExtra {
  jobId?: string;
  meta?: JobMeta;
}

/** A {@link RenderJob} already settled with `outcome`; `.cancel()` is a harmless no-op. */
export function settledJob<T>(
  outcome: { value: T } | { error: unknown },
  extra: JobExtra = {},
): RenderJob<T> {
  const promise =
    'value' in outcome ? Promise.resolve(outcome.value) : Promise.reject(outcome.error);
  return {
    jobId: extra.jobId,
    meta: extra.meta,
    then: (onFulfilled, onRejected) => promise.then(onFulfilled, onRejected),
    catch: (onRejected) => promise.catch(onRejected),
    finally: (onFinally) => promise.finally(onFinally),
    cancel: async () => undefined,
  };
}

/** A {@link RenderJob} a test settles and cancels explicitly, counting `.cancel()` calls. */
export interface DeferredJob<T> {
  readonly job: RenderJob<T>;
  readonly cancelCalls: number;
  settle(value: T): void;
  fail(error: unknown): void;
}

/**
 * A {@link RenderJob} that settles only when the test calls `settle`/`fail`.
 * `.cancel()` only counts its own calls — it never settles the job itself,
 * so a test controls exactly when (and whether) the job's promise resolves.
 */
export function deferredJob<T>(extra: JobExtra = {}): DeferredJob<T> {
  let settleValue!: (value: T) => void;
  let failValue!: (error: unknown) => void;
  let done = false;
  const promise = new Promise<T>((resolve, reject) => {
    settleValue = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    failValue = (error) => {
      if (done) return;
      done = true;
      reject(error);
    };
  });
  let cancelCalls = 0;
  return {
    job: {
      jobId: extra.jobId,
      meta: extra.meta,
      then: (onFulfilled, onRejected) => promise.then(onFulfilled, onRejected),
      catch: (onRejected) => promise.catch(onRejected),
      finally: (onFinally) => promise.finally(onFinally),
      cancel: async () => {
        cancelCalls += 1;
      },
    },
    get cancelCalls() {
      return cancelCalls;
    },
    settle: settleValue,
    fail: failValue,
  };
}

/** A `cancelled`-coded {@link AudioVideoError}, the shape the SDK rejects a cancelled job with. */
export function cancelledError(): AudioVideoError {
  return new AudioVideoError({ message: 'The job was cancelled.', code: 'cancelled' });
}
