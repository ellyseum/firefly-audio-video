/**
 * The SDK's single typed error, {@link AudioVideoError} — every rejection or throw
 * this package produces is one of these. Every field that carries text from a
 * request or a response is redacted at construction time by the SDK's single
 * redaction pass: there is no unredacted form of it to accidentally log or
 * display.
 */

import { brandClass } from './brand.js';
import { redactValue } from './redact.js';

/**
 * Constructor input for {@link AudioVideoError}. `message` and `items` are
 * redacted before being stored; `cause` is kept exactly as given — see
 * {@link AudioVideoError} for why.
 */
export interface AudioVideoErrorOptions {
  /** The human-readable description. Redacted before storage — see class docs. */
  message: string;
  /** The HTTP status this error corresponds to, when it came from a response. */
  status?: number;
  /**
   * A stable, machine-checkable identifier for what went wrong (e.g. `'http_429'`,
   * `'job_failed'`) — meant for `===`/`switch` handling, never for parsing
   * `.message` text. Every code this SDK produces is lowercase `snake_case`; a
   * new code keeps that shape. Defaults to `'audio_video_error'` when omitted, so
   * `.code` is always a defined string.
   */
  code?: string;
  /** The DGR job this error relates to, when one exists. */
  jobId?: string;
  /** The `x-request-id` of the response this error came from, when present. */
  requestId?: string;
  /** Structured detail (e.g. a job's `outputs[].errors`). Redacted before storage. */
  items?: unknown[];
  /** The underlying error, if any — set via the native `Error` cause chain. */
  cause?: unknown;
}

/**
 * The redacted, JSON-safe shape {@link AudioVideoError.toJSON} produces.
 */
export interface AudioVideoErrorJSON {
  name: string;
  code: string;
  status?: number;
  jobId?: string;
  requestId?: string;
  message: string;
  items?: unknown[];
}

/**
 * The single error type this SDK throws or rejects with. Extends the native
 * `Error` — so `instanceof Error` and every existing error-handling idiom still
 * work — and adds a stable `.code`, DGR-specific context (`.status`/`.jobId`/
 * `.requestId`/`.items`), and a native `.cause` chain. `instanceof
 * AudioVideoError` holds for an error either of the package's builds made,
 * when a process loads both its ESM and its CommonJS build.
 *
 * Every surface a caller might use to observe this error is pre-redacted:
 * `.message`, `toJSON()` (used by `JSON.stringify`), `toString()`, and the
 * `util.inspect` custom hook (used by `console.log`) — none of them can leak a
 * bearer token, an `x-api-key`, or a presigned URL's signature, because the
 * fields that carry request or response text, `.message` and `.items`, are
 * redacted at construction time. The identifiers are kept as they are: `.code`
 * is one this SDK chooses, and `.jobId` and `.requestId` are exactly what the
 * service sent — the ID `status()` and `cancel()` take, and the one support
 * asks for.
 *
 * `.cause` is the one field kept exactly as given, for programmatic inspection
 * (`err.cause`), and it is deliberately excluded from all three serialized forms
 * above rather than redacted — an arbitrary third-party cause object cannot be
 * walked and reconstructed by the redaction pass without risking corrupting a
 * shape (a real `Error`, a platform exception) this SDK does not own.
 *
 * @example
 * ```ts
 * // The message is redacted as the error is built: a presigned URL in it
 * // loses its signature.
 * throw new AudioVideoError({
 *   message: `Render failed for ${sourceUrl}`,
 *   code: 'render_failed',
 *   status: 403,
 *   jobId,
 *   cause: fetchError,
 * });
 * ```
 */
export class AudioVideoError extends Error {
  /** See {@link AudioVideoErrorOptions.code}. */
  readonly code: string;
  /** See {@link AudioVideoErrorOptions.status}. */
  readonly status?: number;
  /** See {@link AudioVideoErrorOptions.jobId}. */
  readonly jobId?: string;
  /** See {@link AudioVideoErrorOptions.requestId}. */
  readonly requestId?: string;
  /** See {@link AudioVideoErrorOptions.items} — already redacted. */
  readonly items?: unknown[];

  /**
   * Never throws: an option that cannot be read — `options` itself missing,
   * a throwing getter — is left unset, and a non-string `message` is taken by
   * its string form.
   */
  constructor(options: AudioVideoErrorOptions) {
    super(redactValue(messageText(readOption(options, 'message'))), {
      cause: readOption(options, 'cause'),
    });

    // The prototype of the class actually being constructed — this one or a
    // subclass — so `instanceof` holds for both even under a build target that
    // downlevels `class` syntax, where the built-in `Error` constructor resets it.
    Object.setPrototypeOf(this, new.target.prototype);

    const items = readOption(options, 'items');
    this.name = 'AudioVideoError';
    this.code = readOption(options, 'code') ?? 'audio_video_error';
    this.status = readOption(options, 'status');
    this.jobId = readOption(options, 'jobId');
    this.requestId = readOption(options, 'requestId');
    this.items = items === undefined ? undefined : redactValue(items);
  }

  /**
   * The redacted, JSON-safe shape `JSON.stringify(err)` produces — `Error` defines
   * no `toJSON` of its own, so without this an error serializes to `{}`.
   * Deliberately omits `.cause`; see the class docs.
   */
  toJSON(): AudioVideoErrorJSON {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      jobId: this.jobId,
      requestId: this.requestId,
      message: this.message,
      items: this.items,
    };
  }

  /** `"AudioVideoError [CODE]: message"` — every part already redacted. */
  override toString(): string {
    return `${this.name} [${this.code}]: ${this.message}`;
  }

  /**
   * Backs `util.inspect(err)` / `console.log(err)` — `Symbol.for('nodejs.util.inspect.custom')`
   * is the same well-known symbol Node exposes as `util.inspect.custom`. Returns
   * the same redacted shape as {@link AudioVideoError.toJSON} rather than letting the default
   * `Error` inspection run, which would print the redacted `.message` alongside
   * the raw stack, cause, and every other own-enumerable property, unredacted.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): AudioVideoErrorJSON {
    return this.toJSON();
  }

  static {
    brandClass(this, 'AudioVideoError');
  }
}

/** One constructor option, or `undefined` when reading it throws — `options` itself `null`, a throwing getter. */
function readOption<K extends keyof AudioVideoErrorOptions>(
  options: AudioVideoErrorOptions,
  key: K,
): AudioVideoErrorOptions[K] | undefined {
  try {
    return options[key];
  } catch {
    return undefined;
  }
}

/** A message as text: a string as-is, nothing as empty, anything else by its string form. */
function messageText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return String(value);
  } catch {
    return '[Unreadable message]';
  }
}
