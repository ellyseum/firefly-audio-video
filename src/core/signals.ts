/**
 * Abort-signal helpers that work on every Node release the package supports:
 * combining signals, and a delay a signal cuts short. `AbortSignal.any`
 * arrived in Node 18.17 and 20.3 and the package promises Node 18.0 and
 * later, so signals are combined with listeners instead.
 */

/**
 * A signal that aborts, with that signal's reason, as soon as any of
 * `signals` does — at once when one already has. Built on listeners: `release`
 * removes every listener it added from `signals`, which matters when an input
 * outlives the combined signal (a caller's signal shared by many requests);
 * once the combined signal aborts, its listeners are removed on their own.
 *
 * @internal
 */
export function linkSignals(signals: readonly AbortSignal[]): {
  signal: AbortSignal;
  release: () => void;
} {
  const controller = new AbortController();
  const aborted = signals.find((signal) => signal.aborted);
  if (aborted !== undefined) {
    controller.abort(aborted.reason);
    return { signal: controller.signal, release: noop };
  }
  const onAbort = (event: Event): void => {
    controller.abort((event.target as AbortSignal).reason);
  };
  for (const signal of signals) {
    signal.addEventListener('abort', onAbort, { once: true, signal: controller.signal });
  }
  return {
    signal: controller.signal,
    release: () => {
      for (const signal of signals) signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Resolves after `ms` milliseconds, or rejects with `signal.reason` as soon as
 * `signal` aborts — at once when it already has. Built on the global
 * `setTimeout`, so fake timers drive it. Settling either way clears the other
 * half: the abort listener goes when the timer fires, and the timer goes when
 * the signal aborts.
 *
 * @internal
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason as Error);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function noop(): void {}
