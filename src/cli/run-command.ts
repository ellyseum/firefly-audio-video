/**
 * The success/failure envelope every command except `render` uses:
 * `action` runs the command's logic, `runCommand` prints whichever way it
 * settles and ends the process with the matching exit code. `render` cannot
 * share this — it needs its own Ctrl+C handling around the job it starts.
 */

import { exitCodeForError } from './exit-codes.js';
import { printFailure, printSuccess } from './output.js';
import type { CliRuntime } from './runtime.js';

/** What a command's own logic resolves with: the human-mode value, and the `--json` fields. */
export interface CommandOutcome {
  readonly result: unknown;
  readonly json: Record<string, unknown>;
}

/** Runs `action`, prints its outcome, and ends the process — success or failure, exactly once. */
export async function runCommand(
  runtime: CliRuntime,
  json: boolean,
  action: () => Promise<CommandOutcome>,
): Promise<void> {
  try {
    const outcome = await action();
    printSuccess(runtime, json, outcome.result, outcome.json);
    runtime.exit(0);
  } catch (error) {
    printFailure(runtime, json, error);
    runtime.exit(exitCodeForError(error));
  }
}
