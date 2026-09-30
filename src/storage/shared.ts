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

/** @internal Seconds a staged input's URL lasts unless a caller says otherwise: long enough for a queued job to start reading it. */
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
 * hold a presigned URL or a credential. Both pass through the redaction
 * pass, and every string in `secrets` (a credential the provider holds that
 * the redaction pass cannot recognize) is replaced in them as well. An
 * {@link AudioVideoError} passes through as it is.
 *
 * @param message - What failed, without a trailing period.
 */
export function adapterError(
  message: string,
  cause?: unknown,
  secrets: readonly string[] = [],
): AudioVideoError {
  if (cause instanceof AudioVideoError) return cause;
  const detail = cause === undefined ? '' : causeText(cause, secrets);
  return new AudioVideoError({
    message: detail === '' ? `${message}.` : `${message}: ${detail}`,
    code: 'storage_failed',
    ...(cause !== undefined ? { cause: scrubbedCopy(cause, secrets) } : {}),
  });
}

/** @internal An `invalid_argument` error for a provider option or call argument. */
export function invalidOption(message: string): AudioVideoError {
  return new AudioVideoError({ message, code: 'invalid_argument' });
}

/** How much of a cause's message a provider failure repeats. */
const CAUSE_LIMIT = 300;

/** A cause's message, redacted, scrubbed of `secrets`, and cut short. */
function causeText(cause: unknown, secrets: readonly string[]): string {
  let text: string;
  try {
    text = cause instanceof Error ? cause.message : String(cause);
  } catch {
    return '';
  }
  const redacted = scrub(redactValue(text), secrets).trim();
  return redacted.length > CAUSE_LIMIT ? `${redacted.slice(0, CAUSE_LIMIT - 3)}...` : redacted;
}

/** A redacted copy of `cause`, with every message along its cause chain scrubbed of `secrets`. */
function scrubbedCopy(cause: unknown, secrets: readonly string[]): Error {
  const copy = redactError(cause);
  for (let current: unknown = copy; current instanceof Error; current = current.cause) {
    current.message = scrub(current.message, secrets);
  }
  return copy;
}

/** `text` with every occurrence of each non-empty secret replaced. */
function scrub(text: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (out, secret) => (secret === '' ? out : out.split(secret).join('REDACTED')),
    text,
  );
}
