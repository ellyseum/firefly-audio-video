/**
 * Builds a `createProgram()` instance over captured streams, spied `exit`
 * and `forceExit`, and an interrupt source the test presses by hand, for
 * command tests.
 */

import { vi } from 'vitest';
import { createProgram, type CreateProgramOptions } from '../../../src/cli/program.js';

export interface Harness {
  readonly program: ReturnType<typeof createProgram>;
  readonly exit: ReturnType<typeof vi.fn<(code: number) => void>>;
  readonly forceExit: ReturnType<typeof vi.fn<(code: number) => void>>;
  stdoutText(): string;
  stderrText(): string;
  /** Presses Ctrl+C: calls every listener subscribed through the runtime's interrupt source. */
  interrupt(): void;
  /** How many Ctrl+C listeners are subscribed right now. */
  interruptListeners(): number;
  /** Runs `args` as user-supplied CLI arguments (no `node`/script prefix). */
  run(args: readonly string[]): Promise<unknown>;
}

function capturingStream(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const stream = {
    write: (chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    },
  } as NodeJS.WritableStream;
  return { stream, text: () => chunks.join('') };
}

export function createHarness(
  options: Omit<
    CreateProgramOptions,
    'stdout' | 'stderr' | 'exit' | 'forceExit' | 'onInterrupt'
  > = {},
): Harness {
  const stdout = capturingStream();
  const stderr = capturingStream();
  const exit = vi.fn<(code: number) => void>();
  const forceExit = vi.fn<(code: number) => void>();
  const listeners = new Set<() => void>();
  const program = createProgram({
    ...options,
    env: options.env ?? {},
    stdout: stdout.stream,
    stderr: stderr.stream,
    exit,
    forceExit,
    onInterrupt: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  return {
    program,
    exit,
    forceExit,
    stdoutText: stdout.text,
    stderrText: stderr.text,
    interrupt: () => {
      for (const listener of [...listeners]) listener();
    },
    interruptListeners: () => listeners.size,
    run: (args) => program.parseAsync(args as string[], { from: 'user' }),
  };
}
