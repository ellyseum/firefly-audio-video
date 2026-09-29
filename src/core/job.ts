/**
 * The capability-neutral async job engine. A capability supplies a `submit` call
 * that answers `{ jobId, statusUrl }` and a `mapResult` for the terminal status
 * body; this module owns everything in between — polling the status URL on a
 * tiered interval, deciding when the job is terminal (including item-level
 * errors reported while `status` still reads `running`), deriving queue / render
 * / total timing, and cancellation — and hands the caller one {@link AsyncJob}
 * that is both awaitable and a handle. Nothing here knows what is being rendered,
 * transcribed, or generated: `core/` never imports from a capability module, and
 * every status body is read structurally through {@link JobStatusLike}.
 */

import { AudioVideoError } from './errors.js';
import type { HttpClient } from './http.js';

/** One `outputs[]` entry of a status body, reduced to the fields the engine reads. */
export interface JobItemLike {
  /** Raw wire timestamp for when work on this output began. */
  startedDate?: string;
  /** Raw wire timestamp for when this output finished. */
  completedDate?: string;
  /** Errors reported for this output. Any entry makes the whole job terminal. */
  errors?: unknown[];
}

/**
 * The structural shape of a job status body, reduced to the fields the engine
 * reads: terminal detection uses `status`, `errors` and `outputs[].errors`;
 * timing uses `createdDate` and each output's `startedDate` / `completedDate`.
 * Any capability's full status response satisfies this structurally, so the
 * engine never depends on a capability-specific type.
 */
export interface JobStatusLike {
  jobId?: string;
  /** The service's job state, e.g. `running`. Compared case-insensitively. */
  status?: string;
  /** Raw wire timestamp for when the service accepted the job. */
  createdDate?: string;
  /** Job-level errors. Any entry makes the job terminal. */
  errors?: unknown[];
  outputs?: JobItemLike[];
}

/**
 * Timing derived from a job's terminal status body. Every duration is in
 * milliseconds and is `undefined` — never `NaN` — when a date it needs is missing
 * or unparseable. Job-level durations run from `createdDate` to the earliest
 * output `startedDate` (`queueMs`), from that earliest start to the latest output
 * `completedDate` (`renderMs`), and end to end (`totalMs`); `perItem` derives the
 * same three for each output on its own.
 *
 * @example
 * ```ts
 * function logTiming(meta: JobMeta): void {
 *   console.log(`${meta.jobId}: queued ${meta.queueMs} ms, rendered ${meta.renderMs} ms`);
 *   for (const item of meta.perItem) console.log(`  output ${item.index}: ${item.totalMs} ms`);
 * }
 * ```
 */
export interface JobMeta {
  /** The job this timing describes. */
  jobId: string;
  /** `createdDate` as epoch milliseconds — when the service accepted the job. */
  createdAt?: number;
  /** Milliseconds from acceptance to the earliest output starting. */
  queueMs?: number;
  /** Milliseconds from the earliest output starting to the latest output completing. */
  renderMs?: number;
  /** Milliseconds from acceptance to the latest output completing. */
  totalMs?: number;
  /** The same three durations for each `outputs[]` entry, by position. */
  perItem: Array<{ index: number; queueMs?: number; renderMs?: number; totalMs?: number }>;
}

/** What a capability's submit call returns: the accepted job and where to poll it. */
export interface JobSubmission {
  jobId: string;
  /** Absolute or host-relative URL that answers a {@link JobStatusLike} body on `GET`. */
  statusUrl: string;
}

/**
 * One entry of a `job_failed` error's `.items`: the errors reported for a single
 * output (`index` is its position in `outputs[]`), or the job-level errors when
 * `index` is absent.
 */
export interface JobFailureItem {
  index?: number;
  errors: unknown[];
}

/** Milliseconds between polls — a constant, or a function of milliseconds elapsed since the job started. */
export type PollInterval = number | ((elapsedMs: number) => number);

/**
 * What {@link runJob} needs from a capability to drive one job.
 */
export interface RunJobOptions<T> {
  /**
   * Issues the capability's request and returns the accepted job's ID and status
   * URL. Receives the job's abort signal so a cancel during submission can abort
   * the request itself.
   */
  submit: (signal: AbortSignal) => Promise<JobSubmission>;
  /** Builds the job's result from a successful terminal status body and its derived timing. */
  mapResult: (terminal: JobStatusLike, meta: JobMeta) => T;
  /**
   * Aborting it cancels the job exactly as {@link AsyncJob.cancel} does; the
   * abort reason becomes the `cancelled` rejection's `cause`.
   */
  signal?: AbortSignal;
  /** Called once per poll with the raw status body, the terminal poll included. */
  onProgress?: (status: JobStatusLike) => void;
  /**
   * Overrides the default tiered interval (1 s for the first 30 s, then 2 s until
   * two minutes have elapsed, then 5 s). A non-finite or negative value falls back
   * to that default for the poll in question, so a buggy interval function cannot
   * produce a zero-delay poll loop.
   */
  pollIntervalMs?: PollInterval;
  /**
   * Overall budget, in milliseconds from the moment the job is started, for the
   * job to reach a terminal state; exceeding it rejects with `job_timeout`.
   * Unbounded when omitted.
   */
  timeoutMs?: number;
  /** Builds the service path of the cancel endpoint for a job ID. Defaults to `/v1/cancel/{jobId}`. */
  cancelPath?: (jobId: string) => string;
}

/** The lifecycle position `util.inspect` reports for an {@link AsyncJob}. */
type JobState = 'pending' | 'fulfilled' | 'rejected' | 'cancelled';

/** What {@link AsyncJob} exposes to the function that drives it. */
interface JobContext {
  /** Aborted when the job is cancelled or times out; every request and delay must honor it. */
  readonly signal: AbortSignal;
  /** Records the job ID as soon as the submit response carries it. */
  setJobId(jobId: string): void;
  /** Records the derived timing once a terminal status body has been read. */
  setMeta(meta: JobMeta): void;
}

/** Everything {@link AsyncJob} needs to run and cancel one job. */
interface JobDriver<T> {
  /** Runs the job to completion, resolving with its result; rejects on any failure or abort. */
  run(ctx: JobContext): Promise<T>;
  /** Asks the service to stop the job. Its failures are swallowed by the caller. */
  cancelRemote(jobId: string): Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Abort reason set by {@link AsyncJob.cancel}. Any other non-timeout reason came from the caller's own signal. */
const ABORT_CANCELLED: unique symbol = Symbol('AsyncJob.cancelled');

/** Abort reason set when `timeoutMs` elapses. */
const ABORT_TIMEOUT: unique symbol = Symbol('AsyncJob.timeout');

/** The largest delay `setTimeout` honors; anything above is treated as 1 ms by Node. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * A running asynchronous job: awaitable like a promise (`await job`, `job.then()`,
 * `Promise.all([job])`) and holdable as a handle (`job.jobId`, `job.meta`,
 * `job.cancel()`). It settles exactly once — with the capability's mapped result
 * when the job reaches a successful terminal state, or with an
 * {@link AudioVideoError} whose `code` is `job_failed`, `cancelled` or
 * `job_timeout` (or with the error a failing submit or status request threw).
 *
 * `util.inspect` / `console.log` print only `{ jobId, state }` — never a URL or a
 * status body — so a job can be logged freely.
 *
 * Instances are created by the SDK's job runner; application code receives them
 * from a capability method and has no reason to construct one directly.
 *
 * @example
 * ```ts
 * const job: AsyncJob<Result> = startSomething(); // any capability method returning an AsyncJob
 * const giveUp = setTimeout(() => void job.cancel(), 60_000);
 * try {
 *   const result = await job; // resolves once the job is terminal
 *   console.log(job.jobId, job.meta?.totalMs);
 * } finally {
 *   clearTimeout(giveUp);
 * }
 * ```
 */
export class AsyncJob<T> implements PromiseLike<T> {
  readonly #controller = new AbortController();
  readonly #promise: Promise<T>;
  readonly #cancelRemote: (jobId: string) => Promise<void>;
  readonly #jobIdKnown = deferred<string | undefined>();
  readonly #timeoutMs: number | undefined;
  #state: JobState = 'pending';
  #jobId: string | undefined;
  #meta: JobMeta | undefined;
  #timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  #detachExternalSignal: (() => void) | undefined;
  #remoteCancel: Promise<void> | undefined;

  constructor(driver: JobDriver<T>) {
    this.#cancelRemote = driver.cancelRemote;
    this.#timeoutMs = driver.timeoutMs;

    const external = driver.signal;
    if (external?.aborted) this.#controller.abort(external.reason);

    this.#promise = driver
      .run({
        signal: this.#controller.signal,
        setJobId: (jobId) => {
          this.#jobId = jobId;
          this.#jobIdKnown.resolve(jobId);
        },
        setMeta: (meta) => {
          this.#meta = meta;
        },
      })
      .then(
        (value) => {
          this.#settle('fulfilled');
          return value;
        },
        (err: unknown) => {
          const mapped = this.#mapRejection(err);
          this.#settle(isCancellation(mapped) ? 'cancelled' : 'rejected');
          throw mapped;
        },
      );

    if (external) {
      if (external.aborted) {
        void this.#cancelWith(external.reason);
      } else {
        const onAbort = (): void => {
          void this.#cancelWith(external.reason);
        };
        external.addEventListener('abort', onAbort, { once: true });
        this.#detachExternalSignal = () => external.removeEventListener('abort', onAbort);
      }
    }

    if (driver.timeoutMs !== undefined && Number.isFinite(driver.timeoutMs)) {
      this.#timeoutTimer = setTimeout(
        () => this.#controller.abort(ABORT_TIMEOUT),
        Math.min(Math.max(0, driver.timeoutMs), MAX_TIMER_MS),
      );
    }
  }

  /** The service's job ID — `undefined` until the submit response has arrived. */
  get jobId(): string | undefined {
    return this.#jobId;
  }

  /** Timing derived from the terminal status body — `undefined` until the job is terminal. */
  get meta(): JobMeta | undefined {
    return this.#meta;
  }

  /** Attaches fulfillment/rejection handlers to the job's settlement; `await job` works through this. */
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.#promise.then(onfulfilled, onrejected);
  }

  /** Attaches a rejection handler to the job's settlement. */
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T | TResult> {
    return this.#promise.catch(onrejected);
  }

  /** Attaches a handler that runs however the job settles. */
  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.#promise.finally(onfinally);
  }

  /**
   * Cancels the job: stops polling, aborts any in-flight request, and asks the
   * service to stop the job (a `PUT` to the cancel path) on a best-effort basis —
   * a failing cancel request is swallowed. The job itself then rejects with an
   * {@link AudioVideoError} of `code: 'cancelled'`.
   *
   * Resolves once the cancel request has been attempted; if the submit is still in
   * flight it waits for the job ID first, so a cancel issued during submission
   * still reaches the service. Calling this on an already-settled job, or a
   * second time, is a no-op.
   */
  cancel(): Promise<void> {
    return this.#cancelWith(ABORT_CANCELLED);
  }

  /**
   * Backs `util.inspect(job)` / `console.log(job)` — `Symbol.for('nodejs.util.inspect.custom')`
   * is the same well-known symbol Node exposes as `util.inspect.custom`. Prints
   * only the job ID and lifecycle state.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): { jobId: string | undefined; state: JobState } {
    return { jobId: this.#jobId, state: this.#state };
  }

  #cancelWith(reason: unknown): Promise<void> {
    if (this.#state !== 'pending') return Promise.resolve();
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);
    // A job the caller explicitly cancelled and never awaits is not an unhandled rejection.
    this.#promise.catch(noop);
    this.#remoteCancel ??= this.#issueRemoteCancel();
    return this.#remoteCancel;
  }

  async #issueRemoteCancel(): Promise<void> {
    const jobId = await this.#jobIdKnown.promise;
    if (jobId === undefined) return;
    try {
      await this.#cancelRemote(jobId);
    } catch {
      // Best-effort: the local cancellation stands whether or not the service acknowledged it.
    }
  }

  #settle(state: JobState): void {
    this.#state = state;
    if (this.#timeoutTimer !== undefined) clearTimeout(this.#timeoutTimer);
    this.#detachExternalSignal?.();
    this.#jobIdKnown.resolve(this.#jobId);
  }

  /**
   * Turns the raw rejection of an aborted run into the `cancelled` / `job_timeout`
   * error the abort stands for. A rejection that is itself an {@link AudioVideoError}
   * passes through even when the signal is aborted: it describes a definite outcome
   * (`job_failed`, an HTTP failure) that a same-instant cancel must not mask.
   */
  #mapRejection(err: unknown): unknown {
    const { signal } = this.#controller;
    if (!signal.aborted || err instanceof AudioVideoError) return err;
    if (signal.reason === ABORT_TIMEOUT) {
      return new AudioVideoError({
        message: `${describeJob(this.#jobId)} did not reach a terminal state within ${this.#timeoutMs} ms.`,
        code: 'job_timeout',
        jobId: this.#jobId,
      });
    }
    return new AudioVideoError({
      message: `${describeJob(this.#jobId)} was cancelled.`,
      code: 'cancelled',
      jobId: this.#jobId,
      cause: signal.reason === ABORT_CANCELLED ? undefined : signal.reason,
    });
  }
}

/**
 * Starts a job: submits it, polls its status URL until it is terminal, and returns
 * the {@link AsyncJob} that settles with the mapped result.
 *
 * The job is terminal when `status` is one of `succeeded` / `completed` / `failed`
 * / `cancelled` / `canceled` (case-insensitive), or when the body carries any
 * job-level `errors` or any `outputs[].errors` — an output error reported while
 * `status` still reads `running` ends the job. The job then:
 *
 * - resolves with `mapResult(terminal, meta)` for a successful status with no errors;
 * - rejects `job_failed` when any errors are present or the status is `failed`,
 *   with one {@link JobFailureItem} per failing output (and one for job-level
 *   errors) in `.items`, redacted;
 * - rejects `cancelled` when the service reports the job cancelled, when
 *   {@link AsyncJob.cancel} is called, or when `opts.signal` aborts;
 * - rejects `job_timeout` when `opts.timeoutMs` elapses first;
 * - rejects with the submit or status request's own error if one of those fails.
 *
 * `job.meta` is populated from any terminal body, failed ones included. A status
 * body that is not a JSON object is treated as "not yet terminal" and polling
 * continues.
 *
 * @typeParam T - The result type `mapResult` produces.
 * @param http - The client the status polls and the cancel request go through.
 * @param opts - See {@link RunJobOptions}.
 * @returns The job handle; `await` it for the result.
 *
 * @example
 * ```ts
 * const job = runJob(http, {
 *   submit: (signal) =>
 *     http
 *       .request<JobSubmission>('POST', '/v1/templates/render', body, { signal })
 *       .then((res) => res.body),
 *   mapResult: (terminal, meta) => ({ outputs: terminal.outputs, meta }),
 *   onProgress: (status) => console.log(status.status),
 * });
 * const { meta } = await job;
 * ```
 */
export function runJob<T>(http: HttpClient, opts: RunJobOptions<T>): AsyncJob<T> {
  const cancelPath = opts.cancelPath ?? defaultCancelPath;
  return new AsyncJob<T>({
    run: (ctx) => pollUntilTerminal(http, opts, ctx),
    cancelRemote: async (jobId) => {
      await http.request('PUT', cancelPath(jobId));
    },
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });
}

/**
 * Derives {@link JobMeta} from a status body. Each duration is the difference of
 * two parsed dates and is `undefined` whenever either date is missing or
 * unparseable — no metric is ever `NaN`.
 *
 * @param status - A status body, normally the terminal one.
 * @param jobId - The job the timing describes; defaults to the body's own `jobId`.
 */
export function parseTimings(status: JobStatusLike, jobId: string = status.jobId ?? ''): JobMeta {
  const createdAt = parseWireDate(status.createdDate);
  const outputs = Array.isArray(status.outputs) ? status.outputs : [];
  const perItem: JobMeta['perItem'] = [];
  let firstStarted: number | undefined;
  let lastCompleted: number | undefined;

  for (const [index, item] of outputs.entries()) {
    const started = parseWireDate(item.startedDate);
    const completed = parseWireDate(item.completedDate);
    firstStarted = minDefined(firstStarted, started);
    lastCompleted = maxDefined(lastCompleted, completed);
    perItem.push({
      index,
      queueMs: elapsedMs(createdAt, started),
      renderMs: elapsedMs(started, completed),
      totalMs: elapsedMs(createdAt, completed),
    });
  }

  return {
    jobId,
    createdAt,
    queueMs: elapsedMs(createdAt, firstStarted),
    renderMs: elapsedMs(firstStarted, lastCompleted),
    totalMs: elapsedMs(createdAt, lastCompleted),
    perItem,
  };
}

/** Submits, then polls until terminal, throwing for every non-success outcome. */
async function pollUntilTerminal<T>(
  http: HttpClient,
  opts: RunJobOptions<T>,
  ctx: JobContext,
): Promise<T> {
  const { signal } = ctx;
  const intervalFor = resolvePollInterval(opts.pollIntervalMs);
  const startedAt = Date.now();

  signal.throwIfAborted();
  const { jobId, statusUrl } = await opts.submit(signal);
  ctx.setJobId(jobId);

  for (;;) {
    signal.throwIfAborted();
    const { body } = await http.request<unknown>('GET', statusUrl, undefined, { signal });
    const status = asStatusBody(body);
    opts.onProgress?.(status);

    if (isTerminal(status)) {
      const meta = parseTimings(status, jobId);
      ctx.setMeta(meta);
      const failure = terminalFailure(status, jobId);
      if (failure !== undefined) throw failure;
      return opts.mapResult(status, meta);
    }

    await sleep(intervalFor(Date.now() - startedAt), signal);
  }
}

/** Statuses that end a job on their own, without any `errors` present. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'completed',
  'failed',
  'cancelled',
  'canceled',
]);

/** Both spellings the service may use for a job it stopped. */
const CANCELLED_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'canceled']);

/** The normalized status string used for every comparison: trimmed, lowercase, `''` when absent. */
function normalizedStatus(status: JobStatusLike): string {
  return typeof status.status === 'string' ? status.status.trim().toLowerCase() : '';
}

/** True once `status` names a terminal state or any job-level or output-level errors are present. */
function isTerminal(status: JobStatusLike): boolean {
  return TERMINAL_STATUSES.has(normalizedStatus(status)) || collectFailures(status).length > 0;
}

/** Every non-empty `errors` array in the body, job-level first, then per output in order. */
function collectFailures(status: JobStatusLike): JobFailureItem[] {
  const items: JobFailureItem[] = [];
  if (hasEntries(status.errors)) items.push({ errors: status.errors });
  if (Array.isArray(status.outputs)) {
    status.outputs.forEach((output, index) => {
      if (hasEntries(output.errors)) items.push({ index, errors: output.errors });
    });
  }
  return items;
}

/**
 * The error a terminal body rejects with, or `undefined` for a successful one.
 * Errors present anywhere in the body win over the `status` string — a body that
 * carries errors is a failure whatever `status` says.
 */
function terminalFailure(status: JobStatusLike, jobId: string): AudioVideoError | undefined {
  const failures = collectFailures(status);
  const state = normalizedStatus(status);
  if (failures.length > 0 || state === 'failed') {
    return new AudioVideoError({
      message: failureMessage(jobId, status, failures),
      code: 'job_failed',
      jobId,
      items: failures,
    });
  }
  if (CANCELLED_STATUSES.has(state)) {
    return new AudioVideoError({
      message: `Job ${jobId} was cancelled by the service before it completed.`,
      code: 'cancelled',
      jobId,
    });
  }
  return undefined;
}

/** Names which parts of the body failed — indices only, never the error payloads themselves. */
function failureMessage(jobId: string, status: JobStatusLike, failures: JobFailureItem[]): string {
  const indices = failures.flatMap((f) => (f.index === undefined ? [] : [f.index]));
  const parts: string[] = [];
  if (failures.some((f) => f.index === undefined)) parts.push('job-level errors');
  if (indices.length > 0) {
    parts.push(`errors on output${indices.length === 1 ? '' : 's'} ${indices.join(', ')}`);
  }
  const detail =
    parts.length > 0 ? parts.join(' and ') : `status "${status.status}" with no error detail`;
  return `Job ${jobId} failed: ${detail}.`;
}

/** Poll every second for the first 30 s, every 2 s until two minutes have elapsed, then every 5 s. */
function defaultPollInterval(elapsedMs: number): number {
  if (elapsedMs < 30_000) return 1_000;
  if (elapsedMs < 120_000) return 2_000;
  return 5_000;
}

/**
 * Resolves the caller's `pollIntervalMs` into one function of elapsed time. A
 * non-finite or negative result falls back to {@link defaultPollInterval} for that
 * poll, so no interval choice can collapse into a zero-delay loop.
 */
function resolvePollInterval(interval: PollInterval | undefined): (elapsedMs: number) => number {
  const chosen =
    typeof interval === 'function'
      ? interval
      : typeof interval === 'number'
        ? () => interval
        : defaultPollInterval;
  return (elapsedMs) => {
    const ms = chosen(elapsedMs);
    return Number.isFinite(ms) && ms >= 0 ? ms : defaultPollInterval(elapsedMs);
  };
}

/** The service's cancel endpoint for a job. */
function defaultCancelPath(jobId: string): string {
  return `/v1/cancel/${encodeURIComponent(jobId)}`;
}

/** A parsed body that is not a JSON object is read as an empty (non-terminal) status. */
function asStatusBody(body: unknown): JobStatusLike {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as JobStatusLike)
    : {};
}

/**
 * Parses a wire timestamp to epoch milliseconds. Fractional seconds beyond three
 * digits are truncated first, so a nanosecond-precision timestamp parses to the
 * same instant regardless of how many fractional digits the host engine's date
 * parser accepts. Returns `undefined` for a missing, non-string or unparseable
 * value — never `NaN`.
 */
function parseWireDate(value: string | undefined): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const ms = Date.parse(value.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isFinite(ms) ? ms : undefined;
}

/** `to − from`, or `undefined` when either side is unknown. */
function elapsedMs(from: number | undefined, to: number | undefined): number | undefined {
  return from === undefined || to === undefined ? undefined : to - from;
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function hasEntries(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function isCancellation(err: unknown): boolean {
  return err instanceof AudioVideoError && err.code === 'cancelled';
}

function describeJob(jobId: string | undefined): string {
  return jobId === undefined ? 'The job (not yet submitted)' : `Job ${jobId}`;
}

/** `setTimeout`-backed delay that rejects with `signal.reason` the moment `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A promise plus the function that resolves it, for a value produced elsewhere. */
function deferred<V>(): { promise: Promise<V>; resolve: (value: V) => void } {
  let resolve!: (value: V) => void;
  const promise = new Promise<V>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function noop(): undefined {
  return undefined;
}
