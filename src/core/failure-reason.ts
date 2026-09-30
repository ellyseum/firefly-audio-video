/**
 * A failure's service-side reason as one short line, for the places that
 * print an error on one line: the CLI's error line and a log record's
 * `error` field. An {@link AudioVideoError}'s `items` hold the service's
 * own detail, redacted when the error is built: a failed job's
 * `{ index, errors }` entries, or a failed request's response body.
 */

import type { AudioVideoError } from './errors.js';

/** The longest a {@link failureReason} runs, in characters. */
const MAX_REASON_CHARS = 200;

/** The keys a reason's code is read from, in order. */
const CODE_KEYS = ['code', 'error_code', 'error'] as const;

/** The keys a reason's message is read from, in order. */
const MESSAGE_KEYS = ['message', 'detail', 'error_description'] as const;

/**
 * The first reason `items` carry, as `code: message` on one line of at most
 * 200 characters, or `undefined` when they carry none. For an entry holding
 * an `errors` array — a failed job's `{ index, errors }` — the reason is its
 * first error; any other entry is the reason itself. The code is read from
 * `code`, `error_code` or `error`, the message from `message`, `detail` or
 * `error_description`; a string is taken as it is, and an entry with
 * neither a code nor a message as its compact JSON. Runs of whitespace
 * collapse to one space, and a longer line is cut to 199 characters and an
 * ellipsis.
 *
 * @internal
 */
export function failureReason(items: AudioVideoError['items']): string | undefined {
  const first = items?.[0];
  if (first === undefined) return undefined;
  const text = reasonText(isRecord(first) && Array.isArray(first.errors) ? first.errors[0] : first);
  if (text === undefined) return undefined;
  const line = text.replace(/\s+/g, ' ').trim();
  if (line === '') return undefined;
  return line.length > MAX_REASON_CHARS ? `${line.slice(0, MAX_REASON_CHARS - 1)}…` : line;
}

/**
 * `message`, followed by the first reason `items` carry when there is one —
 * `"<message> Reason: <reason>"`, or `First reason:` when they carry more
 * than one — else `message` as it is.
 *
 * @internal
 */
export function withFailureReason(message: string, items: AudioVideoError['items']): string {
  const reason = failureReason(items);
  if (reason === undefined) return message;
  return `${message} ${reasonCount(items ?? []) > 1 ? 'First reason' : 'Reason'}: ${reason}`;
}

/** One entry's reason as text, or `undefined` when there is none to read. */
function reasonText(entry: unknown): string | undefined {
  if (entry === undefined) return undefined;
  if (typeof entry === 'string') return entry;
  if (!isRecord(entry)) return safeJson(entry);
  const code = firstValue(entry, CODE_KEYS, (value) => Number.isFinite(value));
  const message = firstValue(entry, MESSAGE_KEYS, () => false);
  if (code !== undefined && message !== undefined) return `${code}: ${message}`;
  return code ?? message ?? safeJson(entry);
}

/** The first of `keys` holding a non-empty string (or a value `alsoAccept` takes), as text. */
function firstValue(
  entry: Record<string, unknown>,
  keys: readonly string[],
  alsoAccept: (value: unknown) => boolean,
): string | undefined {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (alsoAccept(value)) return String(value);
  }
  return undefined;
}

/** How many reasons `items` carry: each error of an `errors`-holding entry, and every other entry. */
function reasonCount(items: readonly unknown[]): number {
  return items.reduce<number>(
    (count, item) =>
      count + (isRecord(item) && Array.isArray(item.errors) ? item.errors.length : 1),
    0,
  );
}

/** `value` as compact JSON, or `undefined` when it cannot be serialized. */
function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
