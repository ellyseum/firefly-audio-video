import { expect, test } from 'vitest';
import { AudioVideoError } from '../src/core/errors.js';
import { DEFAULT_CONCURRENCY, InMemoryPool } from '../src/core/pool.js';

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

test('one queued task rejecting does not affect its siblings or wedge the queue', async () => {
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
  expect(drained).toBe(true);

  await Promise.all(runs);
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
  const bogusValues = [0, -1, 1.5, NaN];

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
