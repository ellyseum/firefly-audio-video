/**
 * The SDK's single typed error, {@link AudioVideoError} — every rejection or throw
 * this package produces is one of these. Every field a caller might observe is
 * redacted at construction time via {@link redactValue} (./redact.ts): there is
 * no unredacted form of this error to accidentally log or display.
 */

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
 * `.requestId`/`.items`), and a native `.cause` chain.
 *
 * Every surface a caller might use to observe this error is pre-redacted:
 * `.message`, `toJSON()` (used by `JSON.stringify`), `toString()`, and the
 * `util.inspect` custom hook (used by `console.log`) — none of them can leak a
 * bearer token, an `x-api-key`, or a presigned URL's SAS/SigV4 signature, because
 * every field they read was redacted at construction time.
 *
 * `.cause` is the one field kept exactly as given, for programmatic inspection
 * (`err.cause`), and it is deliberately excluded from all three serialized forms
 * above rather than redacted — an arbitrary third-party cause object cannot be
 * walked and reconstructed by {@link redactValue} without risking corrupting a
 * shape (a real `Error`, a platform exception) this SDK does not own.
 *
 * @example
 * ```ts
 * throw new AudioVideoError({
 *   message: `Render failed for ${redactUrl(sourceUrl)}`,
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

  constructor(options: AudioVideoErrorOptions) {
    super(redactValue(options.message), { cause: options.cause });

    // TypeScript/tsup compile a class extending a built-in to native ES2022 `class`
    // syntax today, which keeps the prototype chain intact on its own — this line
    // is a defensive no-op under that target, and the fix if a future build target
    // ever downlevels `class` (e.g. to ES5) and silently breaks `instanceof` again.
    Object.setPrototypeOf(this, AudioVideoError.prototype);

    this.name = 'AudioVideoError';
    this.code = options.code ?? 'audio_video_error';
    this.status = options.status;
    this.jobId = options.jobId;
    this.requestId = options.requestId;
    this.items = options.items === undefined ? undefined : redactValue(options.items);
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
   * the same redacted shape as {@link toJSON} rather than letting the default
   * `Error` inspection run, which would print the redacted `.message` alongside
   * the raw stack, cause, and every other own-enumerable property, unredacted.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): AudioVideoErrorJSON {
    return this.toJSON();
  }
}
