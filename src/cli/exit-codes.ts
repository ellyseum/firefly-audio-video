/**
 * The CLI's exit-code table: one place mapping an {@link AudioVideoError}'s
 * `code` (or a raw commander usage failure) to a process exit code, so every
 * command reports failures the same way and `--help`'s epilog and the
 * README describe exactly what the process does.
 */

import { AudioVideoError } from '../core/errors.js';

/** One row of the exit-code table, in the order `--help` and the README print them. */
export interface ExitCodeEntry {
  readonly code: number;
  readonly meaning: string;
}

/** The full exit-code table. `exitCodeForError` is this table's runtime half. */
export const EXIT_CODES: readonly ExitCodeEntry[] = [
  { code: 0, meaning: 'success' },
  {
    code: 2,
    meaning:
      'a usage error, or the SDK rejected invalid_argument, invalid_preset or missing_peer_dependency',
  },
  { code: 3, meaning: 'auth_failed' },
  {
    code: 4,
    meaning:
      'the job failed, timed out or returned an invalid response, or it was cancelled from outside this process',
  },
  {
    code: 5,
    meaning:
      'a network or HTTP failure: request_failed, request_timeout, http_*, submit_failed, job_poll_failed, asset_fetch_failed or storage_failed',
  },
  { code: 130, meaning: "cancelled by this process's own Ctrl+C" },
  {
    code: 1,
    meaning:
      'anything else, save_failed included: the render finished and its output could not be saved',
  },
] as const;

/** {@link EXIT_CODES}, formatted for `--help`'s epilog. */
export function exitCodesHelpText(): string {
  const width = Math.max(...EXIT_CODES.map((entry) => String(entry.code).length));
  const lines = EXIT_CODES.map(
    (entry) => `  ${entry.code.toString().padStart(width)}  ${entry.meaning}`,
  );
  return ['Exit codes:', ...lines].join('\n');
}

const CODE_2 = new Set(['invalid_argument', 'invalid_preset', 'missing_peer_dependency']);
const CODE_4 = new Set(['job_failed', 'job_timeout', 'invalid_response']);
const CODE_5 = new Set([
  'request_failed',
  'request_timeout',
  'submit_failed',
  'job_poll_failed',
  'asset_fetch_failed',
  'storage_failed',
]);

/**
 * The process exit code for an error a command caught. `cancelledByUser` is
 * `true` only when this process's own Ctrl+C is what cancelled the job — a
 * `cancelled` error from anywhere else (a server-side cancellation, another
 * caller) reports the job as failed rather than as a user-initiated exit.
 * Anything that is not an {@link AudioVideoError} — a plain thrown `Error`,
 * or any other value — reports `1`.
 */
export function exitCodeForError(
  error: unknown,
  options: { cancelledByUser?: boolean } = {},
): number {
  if (!(error instanceof AudioVideoError)) return 1;
  const { code } = error;
  if (CODE_2.has(code)) return 2;
  if (code === 'auth_failed') return 3;
  if (CODE_4.has(code)) return 4;
  if (code === 'cancelled') return options.cancelledByUser === true ? 130 : 4;
  if (CODE_5.has(code) || code.startsWith('http_')) return 5;
  return 1;
}
