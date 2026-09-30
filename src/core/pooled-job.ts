/**
 * Runs one job inside a {@link PoolBackend} slot, submit through settle, and
 * hands the caller a single handle for the whole call. A call moves through
 * four phases: preparing (validation, normalization and any staging of inputs
 * — all before a slot is requested), queued (waiting for a slot), running (the
 * slot is held from the submit until the job settles), and finishing (the slot
 * is released and the job's result becomes the call's value, e.g. by
 * downloading it). Only the job itself occupies a slot: nothing a call does
 * while holding one asks the pool for another, so a full pool can never
 * deadlock on its own callers. Cancelling before the job has started submits
 * nothing; cancelling after delegates to the job. Capability-neutral: nothing
 * here knows what a job produces.
 */

import { AudioVideoError } from './errors.js';
import type { AsyncJob, JobMeta } from './job.js';
import type { PoolBackend } from './pool.js';
import { anySignal } from './signals.js';

/**
 * A running call: awaitable like a promise (`await job`, `job.then()`,
 * `Promise.all([job])`) and holdable as a handle (`job.jobId`, `job.meta`,
 * `job.cancel()`). It settles exactly once — with the call's value, or with an
 * {@link AudioVideoError}.
 */
export interface JobHandle<T> extends PromiseLike<T> {
  /** The service's job ID — `undefined` until the submit response has arrived. */
  readonly jobId: string | undefined;
  /** Timing derived from the terminal status body — `undefined` until the job is terminal. */
  readonly meta: JobMeta | undefined;
  /** Attaches fulfillment/rejection handlers to the call's settlement; `await job` works through this. */
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
  /**
   * Cancels the call. Before the job has been submitted — while the call is
   * validating or staging its inputs, or queued for a pool slot — nothing is
   * submitted and the call rejects at once with `code: 'cancelled'`. Once the
   * job has been submitted, polling stops and the service is asked to stop the
   * job (best-effort); the call rejects `cancelled`. While a finished job's
   * result is being downloaded, the download is aborted. Calling this on a
   * settled call, or a second time, is a no-op.
   */
  cancel(): Promise<void>;
  /** Attaches a rejection handler to the call's settlement. */
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T | TResult>;
  /** Attaches a handler that runs however the call settles. */
  finally(onfinally?: (() => void) | null): Promise<T>;
}

/** @internal How a call settled, as reported to {@link PooledJobOptions.onSettle}. */
export type PooledJobOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** @internal What {@link runPooledJob} needs to drive one call. */
export interface PooledJobOptions<J, T> {
  /** The pool the job runs in. */
  pool: PoolBackend;
  /**
   * Everything that happens before the call asks for a slot — validation,
   * normalization, staging inputs — resolving with the function that starts
   * the job. That function is called once the slot is held, and only if the
   * call has not been cancelled; it must start the job without awaiting
   * anything, and must never call the pool itself. A rejection here settles
   * the call without entering the pool.
   */
  prepare: () => Promise<() => AsyncJob<J>> | (() => AsyncJob<J>);
  /**
   * Turns the job's result into the call's value once the job has released
   * its slot. `signal` aborts if the call is cancelled, or
   * {@link PooledJobOptions.signal} aborts, during this phase.
   */
  finish: (value: J, signal: AbortSignal) => Promise<T> | T;
  /**
   * The caller's signal. Aborting it before the job has started rejects the
   * call `cancelled`, with the abort reason as `cause`, and submits nothing.
   * Once the job has started, the job observes the signal itself — the start
   * function passes it to the job runner.
   */
  signal?: AbortSignal;
  /**
   * Called exactly once, when the call settles, with its outcome and the job
   * it started, if any. Anything it throws is swallowed.
   */
  onSettle?: (outcome: PooledJobOutcome<T>, job: AsyncJob<J> | undefined) => void;
}

/** Returned by a pool task that was admitted after its call had already been cancelled. */
const SKIPPED: unique symbol = Symbol('PooledJob.skipped');

type CallState = 'pending' | 'fulfilled' | 'rejected' | 'cancelled';

/**
 * @internal The {@link JobHandle} {@link runPooledJob} returns. Holds its pool
 * slot from the moment the job is admitted until the job settles, whether it
 * resolves or rejects.
 */
export class PooledJob<J, T> implements JobHandle<T> {
  readonly #promise: Promise<T>;
  readonly #beforeStart = new AbortController();
  readonly #finishing = new AbortController();
  #job: AsyncJob<J> | undefined;
  #state: CallState = 'pending';
  #detachSignal: (() => void) | undefined;

  constructor(options: PooledJobOptions<J, T>) {
    const external = options.signal;
    if (external?.aborted) {
      this.#abortBeforeStart(external.reason);
    } else if (external) {
      const onAbort = (): void => this.#onExternalAbort(external.reason);
      external.addEventListener('abort', onAbort, { once: true });
      this.#detachSignal = () => external.removeEventListener('abort', onAbort);
    }

    this.#promise = this.#run(options).then(
      (value) => {
        this.#settle('fulfilled', options, { ok: true, value });
        return value;
      },
      (error: unknown) => {
        this.#settle(isCancellation(error) ? 'cancelled' : 'rejected', options, {
          ok: false,
          error,
        });
        throw error;
      },
    );
    // A call the caller's signal cancelled carries a handler of its own.
    if (this.#beforeStart.signal.aborted) this.#promise.catch(noop);
  }

  /** See {@link JobHandle.jobId}. */
  get jobId(): string | undefined {
    return this.#job?.jobId;
  }

  /** See {@link JobHandle.meta}. */
  get meta(): JobMeta | undefined {
    return this.#job?.meta;
  }

  /** See {@link JobHandle.then}. */
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.#promise.then(onfulfilled, onrejected);
  }

  /** See {@link JobHandle.catch}. */
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T | TResult> {
    return this.#promise.catch(onrejected);
  }

  /** See {@link JobHandle.finally}. */
  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.#promise.finally(onfinally);
  }

  /** See {@link JobHandle.cancel}. */
  cancel(): Promise<void> {
    if (this.#state !== 'pending') return Promise.resolve();
    // A call the caller explicitly cancelled and never awaits is not an unhandled rejection.
    this.#promise.catch(noop);
    this.#finishing.abort(cancelledError(undefined, 'while its result was being read'));
    if (this.#job !== undefined) return this.#job.cancel();
    this.#abortBeforeStart(undefined);
    return Promise.resolve();
  }

  /**
   * Backs `util.inspect(job)` / `console.log(job)` — `Symbol.for('nodejs.util.inspect.custom')`
   * is the symbol Node exposes as `util.inspect.custom`. Prints only the job ID
   * and the call's lifecycle state.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): { jobId: string | undefined; state: CallState } {
    return { jobId: this.jobId, state: this.#state };
  }

  async #run(options: PooledJobOptions<J, T>): Promise<T> {
    const beforeStart = this.#beforeStart.signal;
    beforeStart.throwIfAborted();
    const start = await untilAborted(Promise.resolve().then(options.prepare), beforeStart);
    const admitted = await untilAborted(
      options.pool.run(async () => {
        if (beforeStart.aborted) return SKIPPED;
        return { value: await this.#start(start) };
      }),
      beforeStart,
    );
    if (admitted === SKIPPED) throw beforeStart.reason;
    const { signal } = options;
    const finishSignal = signal
      ? anySignal([this.#finishing.signal, signal])
      : this.#finishing.signal;
    return options.finish(admitted.value, finishSignal);
  }

  #start(start: () => AsyncJob<J>): AsyncJob<J> {
    this.#job = start();
    return this.#job;
  }

  #onExternalAbort(reason: unknown): void {
    if (this.#state !== 'pending') return;
    this.#promise.catch(noop);
    // Once the job has started it observes this same signal; finish combines it into its own.
    if (this.#job === undefined) this.#abortBeforeStart(reason);
  }

  #abortBeforeStart(cause: unknown): void {
    if (this.#beforeStart.signal.aborted) return;
    this.#beforeStart.abort(cancelledError(cause, 'before it was submitted'));
  }

  #settle(state: CallState, options: PooledJobOptions<J, T>, outcome: PooledJobOutcome<T>): void {
    this.#state = state;
    this.#detachSignal?.();
    try {
      options.onSettle?.(outcome, this.#job);
    } catch {
      // Reporting a settled call must not change how it settled.
    }
  }
}

/**
 * @internal Starts a call that runs its job inside `options.pool`: prepares it
 * at once, waits for a slot, starts the job, holds the slot until the job
 * settles, then finishes the call outside the slot. Returns the handle
 * immediately.
 *
 * @typeParam J - The job's own result type.
 * @typeParam T - The call's value, produced from `J` by `options.finish`.
 * @param options - See {@link PooledJobOptions}.
 */
export function runPooledJob<J, T>(options: PooledJobOptions<J, T>): JobHandle<T> {
  return new PooledJob(options);
}

/**
 * @internal A handle for a call that failed before it could start: it rejects
 * with `error`, has no job ID or timing, and cancelling it is a no-op.
 *
 * @param error - The rejection every consumer of the handle observes.
 */
export function rejectedJob<T>(error: unknown): JobHandle<T> {
  const promise = Promise.reject(error) as Promise<T>;
  return {
    jobId: undefined,
    meta: undefined,
    cancel: () => Promise.resolve(),
    then: (onfulfilled, onrejected) => promise.then(onfulfilled, onrejected),
    catch: (onrejected) => promise.catch(onrejected),
    finally: (onfinally) => promise.finally(onfinally),
  };
}

/** The `cancelled` error a call rejects with when it is cancelled outside its job. */
function cancelledError(cause: unknown, when: string): AudioVideoError {
  return new AudioVideoError({
    message: `The job was cancelled ${when}.`,
    code: 'cancelled',
    cause,
  });
}

function isCancellation(error: unknown): boolean {
  return error instanceof AudioVideoError && error.code === 'cancelled';
}

/**
 * Settles as `promise` does, unless `signal` aborts first — then rejects with
 * `signal.reason` at once and leaves `promise` to settle on its own, its
 * outcome observed so a late rejection is never unhandled.
 */
function untilAborted<V>(promise: Promise<V>, signal: AbortSignal): Promise<V> {
  if (signal.aborted) {
    void promise.catch(noop);
    return Promise.reject(signal.reason);
  }
  return new Promise<V>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function noop(): undefined {
  return undefined;
}
