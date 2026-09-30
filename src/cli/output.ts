/**
 * The CLI's two result renderers. `--json` prints exactly one JSON document
 * to stdout, success or failure; without it, a command prints its result to
 * stdout in a readable form and an error to stderr. A success value prints
 * as its command hands it over: a value a command exists to produce — a URL
 * it staged, a rendered output's read URL — is not scrubbed, and `status`
 * and `cancel` redact the service's body before handing it over, since it
 * echoes each output's presigned write URL. A failure's message always goes
 * through the shared redaction: an {@link AudioVideoError}'s is redacted when
 * the error is built, and any other error's is redacted here. An SDK error's
 * advice is restated in the CLI's terms first ({@link cliMessage}).
 */

import { AudioVideoError } from '../core/errors.js';
import { withFailureReason } from '../core/failure-reason.js';
import { redactValue } from '../core/redact.js';
import { cliMessage } from './advice.js';

/** The streams a command's output goes to — a {@link CliRuntime} satisfies this. */
export interface OutputStreams {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

/**
 * Prints a command's success. `--json` writes `{ ok: true, ...fields }` —
 * `undefined` fields are dropped, exactly as `JSON.stringify` drops them.
 * Otherwise, a string `result` prints bare (a URL, a saved path, generated
 * XML); anything else prints as indented JSON.
 */
export function printSuccess(
  streams: OutputStreams,
  json: boolean,
  result: unknown,
  fields: Record<string, unknown>,
): void {
  if (json) {
    writeJsonLine(streams.stdout, { ok: true, ...fields });
    return;
  }
  writeHuman(streams.stdout, result);
}

/**
 * What a failure concerns beyond the error itself: the job, once the service
 * has accepted it, and the finished output's read URL when what failed was
 * saving that output.
 */
export interface FailureContext {
  /** The job the service accepted, printed when the error does not name it itself. */
  readonly jobId?: string;
  /** The finished output's read URL; printed redacted. */
  readonly readUrl?: string;
}

/**
 * Prints a command's failure. `--json` writes
 * `{ ok: false, error: { code, message, jobId?, requestId?, readUrl?, items? } }`
 * to stdout — the job and request IDs an {@link AudioVideoError} carries,
 * when it carries them, so a caller can pass the job to `dgr status`; the
 * finished output's redacted read URL, when `context` names one, so it can be
 * fetched again without rendering again; and the error's `items`, the
 * service's own reasons. Otherwise the error's message, with the first of
 * those reasons after it ({@link withFailureReason}), and its code go to
 * stderr, followed by the job whenever it is known and the read URL when
 * `context` names a finished output. Nothing else from the error is printed,
 * and all of it is redacted, so a credential passed on the command line or
 * carried in an error's text never reaches either stream.
 */
export function printFailure(
  streams: OutputStreams,
  json: boolean,
  error: unknown,
  context: FailureContext = {},
): void {
  const shape = errorShape(error, context);
  if (json) {
    writeJsonLine(streams.stdout, { ok: false, error: shape });
    return;
  }
  streams.stderr.write(`Error: ${withFailureReason(shape.message, shape.items)}\n`);
  streams.stderr.write(`Code: ${shape.code}\n`);
  if (shape.jobId !== undefined) streams.stderr.write(`Job: ${shape.jobId}\n`);
  if (shape.readUrl !== undefined) streams.stderr.write(`Read URL: ${shape.readUrl}\n`);
}

/**
 * What a failure prints: its code and message, the job and request it
 * concerns when known, where a finished output is, and the service's
 * reasons when it gave any.
 */
interface FailureShape {
  code: string;
  message: string;
  jobId?: string;
  requestId?: string;
  readUrl?: string;
  /** An {@link AudioVideoError}'s `items`, redacted when the error was built. */
  items?: unknown[];
}

function errorShape(error: unknown, context: FailureContext): FailureShape {
  const shape = baseShape(error);
  const jobId = shape.jobId ?? context.jobId;
  return {
    ...shape,
    ...(jobId !== undefined ? { jobId } : {}),
    ...(context.readUrl !== undefined ? { readUrl: redactValue(context.readUrl) } : {}),
  };
}

function baseShape(error: unknown): FailureShape {
  if (error instanceof AudioVideoError) {
    return {
      code: error.code,
      message: cliMessage(error),
      ...(error.jobId !== undefined ? { jobId: error.jobId } : {}),
      ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
      ...(error.items !== undefined ? { items: error.items } : {}),
    };
  }
  if (error instanceof Error) {
    return { code: 'unexpected_error', message: redactValue(error.message) };
  }
  return { code: 'unexpected_error', message: redactValue(String(error)) };
}

function writeJsonLine(stream: NodeJS.WritableStream, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function writeHuman(stream: NodeJS.WritableStream, value: unknown): void {
  if (typeof value === 'string') {
    stream.write(value.endsWith('\n') ? value : `${value}\n`);
    return;
  }
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}
