/**
 * The ambient concurrency pool every job in this SDK runs inside, submit
 * through settle — not just its HTTP calls. Bounding *concurrently active
 * jobs* is what keeps a shared credential's request rate inside whatever
 * budget the API enforces: a caller brings their own loop (`Promise.all`, a
 * `for` loop, a stream) and this pool owns admission, queueing, and slot
 * release around it. It is capability-neutral — governs any job, not only
 * render — and sits behind {@link PoolBackend} so a distributed
 * implementation (e.g. Redis-backed, coordinating several processes that
 * share one credential) can stand in for {@link InMemoryPool} without the
 * client changing.
 */

import { AudioVideoError } from './errors.js';

/**
 * The default concurrency {@link InMemoryPool} uses when none is given — a
 * conservative bound on concurrently active jobs sharing one credential.
 */
export const DEFAULT_CONCURRENCY = 10;

/**
 * A concurrency-limited task scheduler: bounds how many tasks run at once,
 * queues the rest, and reports its own occupancy. {@link InMemoryPool} is the
 * built-in, per-process implementation; anything else satisfying this shape
 * — most importantly a distributed pool coordinating several processes that
 * share one credential — can replace it.
 *
 * A conforming implementation admits queued tasks in FIFO order as slots
 * free up, releases a task's slot the moment it settles whether it resolves
 * or rejects (a rejection must never leave the pool permanently short a
 * slot), and resolves {@link PoolBackend.drain} once nothing is active or
 * queued.
 */
export interface PoolBackend {
  /**
   * Runs `task` once a slot is available, and resolves or rejects with
   * exactly what `task` resolves or rejects with. A task's own outcome never
   * affects any other task's — a rejection here is reported only to this
   * call's caller.
   *
   * A task must never itself await a `run` call on this same pool: once every
   * slot is held by tasks each waiting on their own queued work, no slot can
   * ever free, and the pool deadlocks at any concurrency.
   *
   * @typeParam T - The task's own result type.
   * @param task - The work to run once admitted. Called at most once.
   */
  run<T>(task: () => Promise<T>): Promise<T>;
  /**
   * Resolves the first time nothing is active or queued; a task submitted
   * after the call extends the wait, so under continuous submission it never
   * resolves.
   */
  drain(): Promise<void>;
  /** How many tasks currently hold a slot and are running. */
  readonly active: number;
  /** How many tasks are admitted-but-waiting for a free slot, FIFO. */
  readonly queued: number;
}

/**
 * Construction options for {@link InMemoryPool}.
 */
export interface InMemoryPoolOptions {
  /**
   * The maximum number of tasks this pool runs at once. Must be an integer
   * `>= 1`. Defaults to {@link DEFAULT_CONCURRENCY}.
   */
  concurrency?: number;
}

/**
 * The default {@link PoolBackend}: a per-process concurrency limiter and FIFO
 * queue, with zero dependencies and no timers — a task's own settlement is
 * what admits the next one, so there is nothing to poll.
 *
 * Bounds only the process it runs in. Several instances, each in its own
 * process, sharing one credential each keep their own count — together they
 * can still exceed whatever rate budget that credential is held to. A fleet
 * like that needs a distributed {@link PoolBackend} instead.
 *
 * A task run on a pool must never itself await `run` on that same pool — see
 * {@link PoolBackend.run}.
 *
 * @example
 * ```ts
 * // `render()` and `describe()` already run inside the client's own pool, so
 * // a caller never calls run() on it directly — configure it instead:
 * const a = createClient({ clientId, clientSecret, concurrency: 4 });
 * const b = createClient({ clientId, clientSecret, pool: new InMemoryPool({ concurrency: 4 }) });
 * ```
 */
export class InMemoryPool implements PoolBackend {
  readonly #concurrency: number;
  #active = 0;
  readonly #queue: Array<() => void> = [];
  readonly #idleWaiters: Array<() => void> = [];

  /**
   * @param opts - See {@link InMemoryPoolOptions}.
   * @throws {@link AudioVideoError} `code: 'invalid_argument'` when
   *   `concurrency` is not an integer `>= 1`.
   */
  constructor(opts: InMemoryPoolOptions = {}) {
    const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new AudioVideoError({
        message: `InMemoryPool: concurrency must be an integer >= 1, got ${concurrency}.`,
        code: 'invalid_argument',
      });
    }
    this.#concurrency = concurrency;
  }

  /** See {@link PoolBackend.active}. */
  get active(): number {
    return this.#active;
  }

  /** See {@link PoolBackend.queued}. */
  get queued(): number {
    return this.#queue.length;
  }

  /** See {@link PoolBackend.run}. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  /** See {@link PoolBackend.drain}. */
  async drain(): Promise<void> {
    if (this.#active === 0 && this.#queue.length === 0) return;
    await new Promise<void>((resolve) => {
      this.#idleWaiters.push(resolve);
    });
  }

  /**
   * Resolves immediately with a free slot, or queues and resolves once one
   * opens up. The slot-free branch and the enqueue branch both run to
   * completion synchronously (no `await` inside this method), so calls made
   * back-to-back — e.g. from `tasks.map((t) => pool.run(t))` — queue in the
   * exact order they were made, regardless of what any task itself does.
   */
  #acquire(): Promise<void> {
    if (this.#active < this.#concurrency) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#queue.push(() => {
        this.#active += 1;
        resolve();
      });
    });
  }

  /**
   * Frees the calling task's slot, then either admits the next queued task
   * into it — the pool is not idle, since that task is now active — or, if
   * nothing was queued and nothing else is active, wakes every pending
   * {@link drain}.
   */
  #release(): void {
    this.#active -= 1;
    const next = this.#queue.shift();
    if (next !== undefined) {
      next();
      return;
    }
    if (this.#active === 0) {
      const waiters = this.#idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }
}
