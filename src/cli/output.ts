/**
 * The CLI's two result renderers. `--json` prints exactly one JSON document
 * to stdout, success or failure; without it, a command prints its result to
 * stdout in a readable form and an error to stderr. A success value is the
 * command's own product — a URL it staged, a rendered output, a status body
 * — and prints intact: the SDK already redacted anything in it that needed
 * it (an {@link Asset}'s `toJSON()`), and a value a command exists to
 * produce is not scrubbed. A failure's message always goes through the
 * shared redaction: an {@link AudioVideoError}'s is redacted when the error
 * is built, and any other error's is redacted here.
 */

import { AudioVideoError } from '../core/errors.js';
import { redactValue } from '../core/redact.js';

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
 * Prints a command's failure. `--json` writes
 * `{ ok: false, error: { code, message } }` to stdout; otherwise the error's
 * code and message go to stderr. Never prints anything but `error.code` and
 * the redacted message, so a credential passed on the command line or
 * carried in an error's text never reaches either stream.
 */
export function printFailure(streams: OutputStreams, json: boolean, error: unknown): void {
  const shape = errorShape(error);
  if (json) {
    writeJsonLine(streams.stdout, { ok: false, error: shape });
    return;
  }
  streams.stderr.write(`Error: ${shape.message}\n`);
  streams.stderr.write(`Code: ${shape.code}\n`);
}

/** `{ code, message }` for any thrown value — the two fields a failure ever prints. */
function errorShape(error: unknown): { code: string; message: string } {
  if (error instanceof AudioVideoError) return { code: error.code, message: error.message };
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
