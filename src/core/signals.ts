/**
 * Combining abort signals on every Node release the package supports.
 * `AbortSignal.any` arrived in Node 18.17 and 20.3; the package promises
 * Node 18.0 and later, so nothing calls it without {@link anySignal}'s check.
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
 * `AbortSignal.any(signals)` where the running Node has it, and an equivalent
 * from {@link linkSignals} where it does not (before 18.17 and 20.3). Only the
 * native form lets go of its inputs when the combined signal is dropped, so a
 * caller that can say when it is done with the signal should prefer
 * {@link linkSignals} and call `release`.
 *
 * @internal
 */
export function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const native = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  return typeof native === 'function'
    ? native.call(AbortSignal, [...signals])
    : linkSignals(signals).signal;
}

function noop(): void {}
