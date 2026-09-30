/**
 * What the storage providers share: object keys under a stable prefix, URL
 * lifetimes checked against each platform's limits, a stage input read as an
 * upload body, and a provider failure reported without its URLs or
 * credentials.
 */

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import { AudioVideoError } from '../core/errors.js';
import { redactError, redactValue } from '../core/redact.js';
import { classifyAsset, type StageInput } from '../core/storage.js';

/** @internal The prefix every key a provider writes goes under unless its `prefix` option says otherwise. */
export const DEFAULT_PREFIX = 'firefly-audio-video/';

/**
 * @internal Seconds a staged input's URL lasts unless a caller says otherwise.
 * The URL is minted in the job's pool slot just before the submit, so it has
 * to last from the submit until the render has read the input.
 */
export const READ_EXPIRY_SECONDS = 3_600;

/** @internal Seconds an output's URLs last unless a caller says otherwise: they must outlive the render and the download after it. */
export const OUTPUT_EXPIRY_SECONDS = 86_400;

/** @internal A stage input as an upload sends it: bytes in memory, a file on disk with its size, or a stream. */
export type UploadBody =
  | { readonly kind: 'buffer'; readonly data: Buffer }
  | { readonly kind: 'file'; readonly path: string; readonly size: number }
  | { readonly kind: 'stream'; readonly stream: Readable };

/**
 * @internal A provider's key prefix: the default, or the caller's, ending in
 * `/` unless it is empty.
 *
 * @throws {@link AudioVideoError} `invalid_argument` when it is not a string.
 */
export function keyPrefix(prefix: unknown, provider: string): string {
  if (prefix === undefined) return DEFAULT_PREFIX;
  if (typeof prefix !== 'string') throw invalidOption(`${provider}: prefix must be a string.`);
  return prefix === '' || prefix.endsWith('/') ? prefix : `${prefix}/`;
}

/**
 * @internal The key a stored object gets: `prefix` plus the caller's `key`,
 * or plus a new unique name under `folder` — followed, for a file, by the
 * file's own name, so the object keeps its extension.
 *
 * @throws {@link AudioVideoError} `invalid_argument` for a `key` that is not
 *   a non-empty string.
 */
export function objectKey(
  prefix: string,
  key: unknown,
  folder: 'staged' | 'outputs',
  body?: UploadBody,
): string {
  if (key !== undefined) {
    if (typeof key !== 'string' || key === '') {
      throw invalidOption('key must be a non-empty string when provided.');
    }
    return `${prefix}${key}`;
  }
  const name = body?.kind === 'file' ? `/${basename(body.path)}` : '';
  return `${prefix}${folder}/${randomUUID()}${name}`;
}

/**
 * @internal A URL lifetime, in whole seconds from `min` to `max`.
 *
 * @param where - Names the value in the error message.
 * @throws {@link AudioVideoError} `invalid_argument` for anything else.
 */
export function checkExpiry(value: unknown, where: string, max: number, min = 1): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) {
    return value;
  }
  throw invalidOption(`${where} must be a whole number of seconds from ${min} to ${max}.`);
}

/**
 * @internal Reads a stage input as an upload body. A provider uploads local
 * bytes, so an http(s) URL is refused: DGR can read it as it is. A failure to
 * read a file is scrubbed of `secrets`, as {@link adapterError} does.
 *
 * @throws {@link AudioVideoError} `invalid_argument` for an http(s) URL, or
 *   anything `normalizeAsset` refuses.
 */
export async function uploadBody(
  input: StageInput,
  provider: string,
  secrets: readonly string[] = [],
): Promise<UploadBody> {
  const asset = await classifyAsset(input);
  if (asset.kind === 'url') {
    throw invalidOption(
      `${provider} uploads local files, Buffers and Readables, and this input is an http(s) URL ` +
        'DGR can read as it is: pass it to the render directly.',
    );
  }
  const value = asset.input;
  if (Buffer.isBuffer(value)) return { kind: 'buffer', data: value };
  if (typeof value !== 'string') return { kind: 'stream', stream: value };
  try {
    return { kind: 'file', path: value, size: (await stat(value)).size };
  } catch (error) {
    throw adapterError('Reading the input file failed', error, secrets);
  }
}

/**
 * @internal Reads a stream to its end into one `Buffer`, for an upload that
 * needs the length first. A failure is scrubbed of `secrets`, as
 * {@link adapterError} does.
 */
export async function readAll(stream: Readable, secrets: readonly string[] = []): Promise<Buffer> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array));
    }
  } catch (error) {
    throw adapterError('Reading the input stream failed', error, secrets);
  }
  return Buffer.concat(chunks);
}

/**
 * @internal A provider's own failure as `storage_failed`: `message`, then the
 * cause's message, and a copy of the cause — never the original, which may
 * hold a presigned URL or a credential. Every string in `secrets` (a
 * credential the provider holds that the redaction pass cannot recognize) is
 * removed first, in each spelling {@link heldSecretPattern} matches, from the
 * cause's message and from the message, name and code on every level of the
 * copy; only then does the redaction pass run. The order matters: the pass
 * rewrites what it recognizes — it takes a connection string's key out of the
 * middle of the string, and re-encodes a query string it strips — after which
 * a held secret no longer reads as itself. An {@link AudioVideoError} passes
 * through as it is.
 *
 * @param message - What failed, without a trailing period.
 */
export function adapterError(
  message: string,
  cause?: unknown,
  secrets: readonly string[] = [],
): AudioVideoError {
  if (cause instanceof AudioVideoError) return cause;
  const scrub = secretScrub(secrets);
  const detail = cause === undefined ? '' : causeText(cause, scrub);
  return new AudioVideoError({
    message: detail === '' ? `${message}.` : `${message}: ${detail}`,
    code: 'storage_failed',
    ...(cause !== undefined ? { cause: redactError(cause, scrub) } : {}),
  });
}

/** @internal An `invalid_argument` error for a provider option or call argument. */
export function invalidOption(message: string): AudioVideoError {
  return new AudioVideoError({ message, code: 'invalid_argument' });
}

/** How much of a cause's message a provider failure repeats. */
const CAUSE_LIMIT = 300;

/** A cause's message with the held secrets removed, then redacted, and cut short. */
function causeText(cause: unknown, scrub: (text: string) => string): string {
  let text: string;
  try {
    text = cause instanceof Error ? cause.message : String(cause);
  } catch {
    return '';
  }
  const redacted = redactValue(scrub(text)).trim();
  return redacted.length > CAUSE_LIMIT ? `${redacted.slice(0, CAUSE_LIMIT - 3)}...` : redacted;
}

/** Replaces every spelling of the held `secrets` in a text with `REDACTED`. */
function secretScrub(secrets: readonly string[]): (text: string) => string {
  const pattern = heldSecretPattern(secrets);
  return pattern === undefined ? (text) => text : (text) => text.replace(pattern, 'REDACTED');
}

/**
 * Every spelling an encoder or a decoder could give the non-empty `secrets`
 * in a third party's error text, as one pattern: each character as itself or
 * percent-encoded as UTF-8 (either hex case, once or twice); a `+` also as
 * the space form-decoding reads it as; `+` and `/` also as base64url's `-` and
 * `_`; and the trailing `=` padding in part or not at all. Letters and digits
 * match only as they are, which no common encoder changes. A longer secret is
 * tried first, so one that begins with another is removed whole rather than
 * cut after the shorter one. `undefined` when there is none.
 */
function heldSecretPattern(secrets: readonly string[]): RegExp | undefined {
  const sources = [...new Set(secrets)]
    .filter((secret) => secret !== '')
    .sort((a, b) => b.length - a.length)
    .map(spellingsOf);
  return sources.length === 0 ? undefined : new RegExp(sources.join('|'), 'gu');
}

/**
 * The pattern for every spelling of one secret. A secret that is nothing but
 * `=` keeps every character required: a pattern of optional padding alone
 * would match the empty string at every position of the text.
 */
function spellingsOf(secret: string): string {
  const body = secret.replace(/=+$/, '');
  if (body === '') return [...secret].map(characterForms).join('');
  const padding = secret.length - body.length;
  const tail = padding > 0 ? `${characterForms('=')}{0,${padding}}` : '';
  return [...body].map(characterForms).join('') + tail;
}

/** One character of a secret in every form {@link heldSecretPattern} lists. */
function characterForms(character: string): string {
  if (/^[A-Za-z0-9]$/.test(character)) return character;
  const forms = [literal(character), percentEncoded(character)];
  if (character === '+') forms.push(literal(' '), percentEncoded(' '), literal('-'));
  if (character === '/') forms.push(literal('_'));
  return `(?:${forms.join('|')})`;
}

/** `character` percent-encoded as UTF-8, once (`%2B`) or twice (`%252B`), each hex letter in either case. */
function percentEncoded(character: string): string {
  return [...Buffer.from(character, 'utf8')].map((byte) => `%(?:25)?${hexDigits(byte)}`).join('');
}

/** A byte's two hex digits, each letter matching in either case. */
function hexDigits(byte: number): string {
  return byte
    .toString(16)
    .padStart(2, '0')
    .replace(/[a-f]/g, (digit) => `[${digit}${digit.toUpperCase()}]`);
}

/** A pattern matching exactly `character`, whatever it means in a pattern. */
function literal(character: string): string {
  return `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`;
}
