/** Builds a `createProgram()` instance over captured streams and a spied `exit`, for command tests. */

import { vi } from 'vitest';
import { createProgram, type CreateProgramOptions } from '../../../src/cli/program.js';

export interface Harness {
  readonly program: ReturnType<typeof createProgram>;
  readonly exit: ReturnType<typeof vi.fn<(code: number) => void>>;
  stdoutText(): string;
  stderrText(): string;
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
  options: Omit<CreateProgramOptions, 'stdout' | 'stderr' | 'exit'> = {},
): Harness {
  const stdout = capturingStream();
  const stderr = capturingStream();
  const exit = vi.fn<(code: number) => void>();
  const program = createProgram({
    ...options,
    env: options.env ?? {},
    stdout: stdout.stream,
    stderr: stderr.stream,
    exit,
  });
  return {
    program,
    exit,
    stdoutText: stdout.text,
    stderrText: stderr.text,
    run: (args) => program.parseAsync(args as string[], { from: 'user' }),
  };
}
