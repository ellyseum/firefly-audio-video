import { expect, test } from 'vitest';
import { AudioVideoError } from '../src/core/errors.js';
import { DEFAULT_CONCURRENCY, InMemoryPool, type InMemoryPoolOptions } from '../src/core/pool.js';

/** A promise plus the function that resolves it, for controlling exactly when a pooled task settles. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** One real macrotask turn — drains every pending microtask, however many `.then` hops deep. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// --- admission + concurrency cap ---------------------------------------------------

test('with concurrency 2 and 5 tasks, active never exceeds 2 and each resolves with its own value', async () => {
  const pool = new InMemoryPool({ concurrency: 2 });
  const gates = Array.from({ length: 5 }, () => deferred<void>());
  const activeAtStart: number[] = [];

  const results = Promise.all(
    gates.map((gate, i) =>
      pool.run(async () => {
        activeAtStart.push(pool.active);
        await gate.promise;
        return i;
      }),
    ),
  );

  await flush();
  expect(pool.active).toBe(2);
  expect(pool.queued).toBe(3);

  for (const gate of gates) {
    gate.resolve();
    await flush();
    expect(pool.active).toBeLessThanOrEqual(2);
  }

  await expect(results).resolves.toEqual([0, 1, 2, 3, 4]);
  expect(activeAtStart).toEqual([2, 2, 2, 2, 2]);
  expect(pool.active).toBe(0);
  expect(pool.queued).toBe(0);
});

test('admits queued tasks in FIFO order', async () => {
  const pool = new InMemoryPool({ concurrency: 1 });
  const gates = Array.from({ length: 4 }, () => deferred<void>());
  const startOrder: number[] = [];

  const results = Promise.all(
    gates.map((gate, i) =>
      pool.run(async () => {
        startOrder.push(i);
        await gate.promise;
        return i;
      }),
    ),
  );

  await flush();
  expect(startOrder).toEqual([0]);

  for (const gate of gates) {
    gate.resolve();
    await flush();
  }

  await expect(results).resolves.toEqual([0, 1, 2, 3]);
  expect(startOrder).toEqual([0, 1, 2, 3]);
});

test('a release admits its queued successor before a run() issued in the same microtask batch can take the slot', async () => {
  const pool = new InMemoryPool({ concurrency: 1 });
  const gate = deferred<void>();
  const trigger = deferred<void>();
  const startOrder: string[] = [];
  let maxActive = 0;

  const first = pool.run(() => {
    startOrder.push('first');
    return gate.promise;
  });

  await flush();
  expect(pool.active).toBe(1);

  const queued = pool.run(async () => {
    maxActive = Math.max(maxActive, pool.active);
    startOrder.push('queued');
    return 'queued';
  });

  await flush();
  expect(pool.queued).toBe(1);

  // Registered before either gate settles, so this reaction and the first
  // task's own await-continuation land in the same batch of microtasks that
  // gate.resolve()/trigger.resolve() below schedule.
  let late: Promise<string> | undefined;
  trigger.promise.then(() => {
    late = pool.run(async () => {
      maxActive = Math.max(maxActive, pool.active);
      startOrder.push('late');
      return 'late';
    });
  });

  gate.resolve();
  trigger.resolve();

  await flush();
  expect(startOrder).toEqual(['first', 'queued', 'late']);
  expect(maxActive).toBe(1);

  await expect(first).resolves.toBeUndefined();
  await expect(queued).resolves.toBe('queued');
  await expect(late).resolves.toBe('late');
});

test('concurrency 1 fully serializes: never more than one task active at once', async () => {
  const pool = new InMemoryPool({ concurrency: 1 });
  const gates = Array.from({ length: 3 }, () => deferred<void>());
  const activeAtStart: number[] = [];

  const results = Promise.all(
    gates.map((gate, i) =>
      pool.run(async () => {
        activeAtStart.push(pool.active);
        await gate.promise;
        return i;
      }),
    ),
  );

  for (const gate of gates) {
    await flush();
    gate.resolve();
  }
  await results;

  expect(activeAtStart).toEqual([1, 1, 1]);
  expect(pool.active).toBe(0);
});

test('200 tasks at concurrency 10 all complete, with active never exceeding 10', async () => {
  const pool = new InMemoryPool({ concurrency: 10 });
  const total = 200;
  let maxActiveObserved = 0;

  const results = await Promise.all(
    Array.from({ length: total }, (_, i) =>
      pool.run(async () => {
        maxActiveObserved = Math.max(maxActiveObserved, pool.active);
        await Promise.resolve();
        return i;
      }),
    ),
  );

  expect(results).toEqual(Array.from({ length: total }, (_, i) => i));
  expect(maxActiveObserved).toBe(10);
  expect(pool.active).toBe(0);
  expect(pool.queued).toBe(0);
});

// --- rejection handling -------------------------------------------------------------

test('a rejected task rejects its own caller, releases its slot, and a subsequent run still succeeds', async () => {
  const pool = new InMemoryPool({ concurrency: 1 });
  const boom = new Error('task failed');

  await expect(
    pool.run(async () => {
      throw boom;
    }),
  ).rejects.toBe(boom);

  expect(pool.active).toBe(0);
  expect(pool.queued).toBe(0);

  await expect(pool.run(async () => 'ok')).resolves.toBe('ok');
});

test('an active task rejecting while others wait does not wedge the queue', async () => {
  const pool = new InMemoryPool({ concurrency: 1 });
  const boom = new Error('boom');
  const gate1 = deferred<void>();

  const p0 = pool.run(async () => {
    throw boom;
  });
  const p1 = pool.run(async () => {
    await gate1.promise;
    return 'one';
  });
  const p2 = pool.run(async () => 'two');

  await expect(p0).rejects.toBe(boom);
  await flush();
  expect(pool.active).toBe(1);
  expect(pool.queued).toBe(1);

  gate1.resolve();
  await expect(p1).resolves.toBe('one');
  await expect(p2).resolves.toBe('two');
  expect(pool.active).toBe(0);
  expect(pool.queued).toBe(0);
});

test('a task that throws synchronously still releases its slot and lets a queued sibling run', async () => {
  const pool = new InMemoryPool({ concurrency: 1 });
  const boom = new Error('boom');
  const siblingGate = deferred<string>();

  const first = pool.run(() => {
    throw boom;
  });
  const queued = pool.run(() => siblingGate.promise);

  await expect(first).rejects.toBe(boom);
  expect(pool.queued).toBe(0);

  await flush();
  expect(pool.active).toBe(1); // the queued sibling was admitted into the freed slot

  siblingGate.resolve('sibling');
  await expect(queued).resolves.toBe('sibling');
  expect(pool.active).toBe(0);
});

// --- drain ---------------------------------------------------------------------------

test('drain() resolves immediately on an idle pool', async () => {
  const pool = new InMemoryPool({ concurrency: 2 });
  await expect(pool.drain()).resolves.toBeUndefined();
});

test('drain() resolves only once every active and queued task has settled', async () => {
  const pool = new InMemoryPool({ concurrency: 2 });
  const gates = Array.from({ length: 4 }, () => deferred<void>());
  let drained = false;

  const runs = gates.map((gate) => pool.run(() => gate.promise));
  const drainPromise = pool.drain().then(() => {
    drained = true;
  });

  await flush();
  expect(drained).toBe(false);

  gates[0]!.resolve();
  gates[1]!.resolve();
  await flush();
  expect(drained).toBe(false); // tasks 2 and 3 were admitted behind 0 and 1, and are still pending

  gates[2]!.resolve();
  gates[3]!.resolve();
  await drainPromise;
  expect(pool.active).toBe(0);
  expect(pool.queued).toBe(0);

  await Promise.all(runs);
});

test('drain() keeps waiting for a task submitted after it was called, even once it is admitted into a freed slot', async () => {
  const pool = new InMemoryPool({ concurrency: 2 });
  const gate1 = deferred<void>();
  let drained = false;

  const task1 = pool.run(() => gate1.promise);
  await flush();
  expect(pool.active).toBe(1);

  const drainPromise = pool.drain().then(() => {
    drained = true;
  });

  const gate2 = deferred<void>();
  const task2 = pool.run(() => gate2.promise);
  await flush();
  expect(pool.active).toBe(2);

  gate1.resolve();
  await flush();
  expect(pool.active).toBe(1);
  expect(drained).toBe(false); // task2 arrived after drain() was called; it must be awaited too

  gate2.resolve();
  await drainPromise;
  expect(pool.active).toBe(0);
  expect(pool.queued).toBe(0);

  await Promise.all([task1, task2]);
});

test('drain() stays pending while a task is still active even though the queue is empty', async () => {
  const pool = new InMemoryPool({ concurrency: 2 });
  const gate1 = deferred<void>();
  const gate2 = deferred<void>();
  let drained = false;

  const task1 = pool.run(() => gate1.promise);
  const task2 = pool.run(() => gate2.promise);
  await flush();
  expect(pool.active).toBe(2);
  expect(pool.queued).toBe(0);

  const drainPromise = pool.drain().then(() => {
    drained = true;
  });

  gate1.resolve();
  await flush();
  expect(pool.active).toBe(1);
  expect(pool.queued).toBe(0);
  expect(drained).toBe(false); // the queue is empty, but a task is still active

  gate2.resolve();
  await drainPromise;
  expect(pool.active).toBe(0);
  expect(pool.queued).toBe(0);

  await Promise.all([task1, task2]);
});

// --- configuration + validation -------------------------------------------------------

test('DEFAULT_CONCURRENCY is 10, and InMemoryPool() with no options uses it', async () => {
  expect(DEFAULT_CONCURRENCY).toBe(10);

  const pool = new InMemoryPool();
  const gates = Array.from({ length: DEFAULT_CONCURRENCY + 1 }, () => deferred<void>());
  const runs = gates.map((gate) => pool.run(() => gate.promise));

  await flush();
  expect(pool.active).toBe(DEFAULT_CONCURRENCY);
  expect(pool.queued).toBe(1);

  for (const gate of gates) gate.resolve();
  await Promise.all(runs);
  expect(pool.active).toBe(0);
});

test('an invalid concurrency (not an integer >= 1) throws invalid_argument', () => {
  const bogusValues = [0, -1, 1.5, NaN, Infinity, '3' as unknown as number];

  for (const concurrency of bogusValues) {
    let caught: unknown;
    try {
      new InMemoryPool({ concurrency });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AudioVideoError);
    expect((caught as AudioVideoError).code).toBe('invalid_argument');
  }
});

test("an invalid concurrency's error message names the received value's type", () => {
  const thrown = (concurrency: number): string => {
    try {
      new InMemoryPool({ concurrency });
    } catch (err) {
      return (err as AudioVideoError).message;
    }
    throw new Error('expected InMemoryPool to throw');
  };

  expect(thrown(3.5)).toContain('got 3.5');
  expect(thrown('3' as unknown as number)).toContain('got "3"');
});

test('a null options object is treated the same as omitting it', () => {
  const nullOpts = null as unknown as InMemoryPoolOptions;
  expect(() => new InMemoryPool(nullOpts)).not.toThrow();
  const pool = new InMemoryPool(nullOpts);
  expect(pool.active).toBe(0);
});

test("run() rejects invalid_argument when task isn't a function", async () => {
  const pool = new InMemoryPool({ concurrency: 1 });
  const notATask = Promise.resolve('oops') as unknown as () => Promise<string>;

  let caught: unknown;
  try {
    await pool.run(notATask);
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(AudioVideoError);
  expect((caught as AudioVideoError).code).toBe('invalid_argument');
  expect(pool.active).toBe(0);
  expect(pool.queued).toBe(0);
});

test('admission stays correct across a queue backlog large enough to force compaction', async () => {
  const pool = new InMemoryPool({ concurrency: 1 });
  const total = 5000;
  const startOrder: number[] = [];

  const results = Promise.all(
    Array.from({ length: total }, (_, i) =>
      pool.run(async () => {
        startOrder.push(i);
        return i;
      }),
    ),
  );

  await expect(results).resolves.toEqual(Array.from({ length: total }, (_, i) => i));
  expect(startOrder).toEqual(Array.from({ length: total }, (_, i) => i));
  expect(pool.active).toBe(0);
  expect(pool.queued).toBe(0);
});
