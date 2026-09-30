import { getEventListeners } from 'node:events';
import { expect, test, vi } from 'vitest';
import { delay, linkSignals } from '../src/core/signals.js';

test('linkSignals: aborts with the reason of whichever input aborts first', () => {
  const a = new AbortController();
  const b = new AbortController();
  const { signal } = linkSignals([a.signal, b.signal]);
  expect(signal.aborted).toBe(false);

  const first = new Error('b first');
  b.abort(first);
  a.abort(new Error('a later'));

  expect(signal.aborted).toBe(true);
  expect(signal.reason).toBe(first);
});

test('linkSignals: an input that has already aborted aborts the result at once, with its reason', () => {
  const reason = new Error('already');
  const { signal } = linkSignals([new AbortController().signal, AbortSignal.abort(reason)]);

  expect(signal.aborted).toBe(true);
  expect(signal.reason).toBe(reason);
});

test('linkSignals: release removes its listener from every input, and an abort removes the rest on its own', () => {
  const a = new AbortController();
  const b = new AbortController();
  const link = linkSignals([a.signal, b.signal]);
  expect(getEventListeners(a.signal, 'abort')).toHaveLength(1);
  expect(getEventListeners(b.signal, 'abort')).toHaveLength(1);

  link.release();
  expect(getEventListeners(a.signal, 'abort')).toHaveLength(0);
  expect(getEventListeners(b.signal, 'abort')).toHaveLength(0);

  const c = new AbortController();
  const d = new AbortController();
  linkSignals([c.signal, d.signal]);
  c.abort();
  expect(getEventListeners(d.signal, 'abort')).toHaveLength(0);
});

test('delay: resolves once its time has passed, leaving no listener on the signal', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const controller = new AbortController();
    let settled = false;
    const waiting = delay(250, controller.signal).then(() => {
      settled = true;
    });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;

    expect(settled).toBe(true);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

test('delay: an abort mid-wait rejects with the reason at once and clears the timer and the listener', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const controller = new AbortController();
    const waiting = delay(10_000, controller.signal);
    expect(vi.getTimerCount()).toBe(1);

    const reason = new Error('stopped');
    controller.abort(reason);

    await expect(waiting).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

test('delay: a signal that has already aborted rejects at once, starting no timer', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const reason = new Error('already');
    const waiting = delay(10_000, AbortSignal.abort(reason));

    expect(vi.getTimerCount()).toBe(0);
    await expect(waiting).rejects.toBe(reason);
  } finally {
    vi.useRealTimers();
  }
});

test('delay: without a signal it simply waits', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    let settled = false;
    const waiting = delay(5).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5);
    await waiting;
    expect(settled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
