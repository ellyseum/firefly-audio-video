/**
 * Zero-dependency structured logging: one flat NDJSON record per settled call,
 * redacted before any sink sees it. Logging is on unless a caller disables it —
 * {@link resolveLogger} turns an omitted option into the stdout logger. Every
 * record the SDK writes goes through {@link emit}, the single dispatch path that
 * runs {@link redactValue} and never lets a sink failure surface as a throw. Two
 * sinks ship with the package, {@link stdoutJsonLogger} and
 * {@link rotatingFileLogger}, and any object with a `log(record)` method is a
 * {@link Logger}, so a consumer can route records into pino, winston, or a
 * pipeline of their own. Capability-neutral: nothing here knows what a record's
 * `endpoint` does, and nothing here is imported from a capability module.
 */

import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { AudioVideoError } from './errors.js';
import type { JobMeta } from './job.js';
import { redactValue } from './redact.js';

/** The severity of a {@link LogRecord}. */
export type LogLevel = 'info' | 'warn' | 'error';

/**
 * One log record. Flat by contract: every field is a string or a number and
 * none is an object or an array, so a column-based ingester maps each field to
 * a column and a plain `grep` finds any value. A new field keeps that shape.
 *
 * `time`, `level` and `msg` are the conventional top-level names JSON log
 * parsers key on; the rest are optional per-call detail — a capability sets the
 * ones that apply to its call and omits the others.
 */
export interface LogRecord {
  /** ISO-8601 timestamp of the moment the record was built. */
  time: string;
  /** Severity of the record. */
  level: LogLevel;
  /** A short human-readable summary, e.g. `'render completed'`. */
  msg: string;
  /** The API operation the record describes, e.g. `'POST /v1/templates/render'`. */
  endpoint?: string;
  /** The service job the record describes, when one exists. */
  jobId?: string;
  /** Milliseconds from job acceptance to the earliest output starting. */
  queueMs?: number;
  /** Milliseconds from the earliest output starting to the latest output completing. */
  renderMs?: number;
  /** Milliseconds from job acceptance to the latest output completing. */
  totalMs?: number;
  /** The preset the call used, when applicable. */
  preset?: string;
  /** The output codec, when known. */
  codec?: string;
  /** The output resolution, e.g. `'1920x1080'`, when known. */
  resolution?: string;
  /** The number of outputs the job produced, when known. */
  totalJobItems?: number;
  /** The job's terminal status as reported by the service, e.g. `'succeeded'`. */
  status?: string;
  /** The failure that settled the call, rendered as one redacted `code: message` string. */
  error?: string;
}

/**
 * A log sink. The SDK calls `log` once per record with a record that has already
 * passed through {@link redactValue}, and catches anything `log` throws, so a
 * sink neither sees a secret nor breaks the call being logged. Any object with
 * this shape works: the built-in {@link stdoutJsonLogger} and
 * {@link rotatingFileLogger}, or an adapter over pino, winston, or a custom
 * pipeline.
 *
 * @example
 * ```ts
 * const viaPino: Logger = { log: (record) => pino.info(record, record.msg) };
 * ```
 */
export interface Logger {
  log(record: LogRecord): void;
}

/**
 * A {@link Logger} that writes one NDJSON line per record —
 * `JSON.stringify(record) + '\n'` — to `stream`, `process.stdout` by default.
 * The line is handed to the stream synchronously; there is no buffer, queue, or
 * worker thread of its own in between.
 *
 * @param stream - The destination; any writable stream.
 * @returns A logger bound to `stream`.
 *
 * @example
 * ```ts
 * const logger = stdoutJsonLogger();
 * logger.log({ time: new Date().toISOString(), level: 'info', msg: 'hello' });
 * // stdout: {"time":"2026-09-29T12:00:00.000Z","level":"info","msg":"hello"}
 * ```
 */
export function stdoutJsonLogger(stream: NodeJS.WritableStream = process.stdout): Logger {
  return {
    log(record) {
      stream.write(`${JSON.stringify(record)}\n`);
    },
  };
}

/** Default {@link RotatingFileLoggerOptions.maxBytes}: 10 MiB. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** Default {@link RotatingFileLoggerOptions.maxFiles}. */
const DEFAULT_MAX_FILES = 5;

/**
 * Options for {@link rotatingFileLogger}.
 */
export interface RotatingFileLoggerOptions {
  /** The current log file. Rotated copies live beside it as `<path>.1` … `<path>.<maxFiles>`. */
  path: string;
  /** The size, in bytes, a file may reach before it rotates. Defaults to 10 MiB. */
  maxBytes?: number;
  /**
   * How many rotated copies to keep — `<path>.1` is the newest, `<path>.<maxFiles>`
   * the oldest, and the oldest is dropped on each rotation. `0` keeps none: the
   * current file is deleted instead of renamed. Defaults to 5.
   */
  maxFiles?: number;
}

/**
 * A {@link Logger} that appends one NDJSON line per record to a file and rotates
 * it by size: when a line would push the file past `maxBytes`, `<path>` becomes
 * `<path>.1`, each existing `<path>.N` becomes `<path>.N+1`, `<path>.<maxFiles>`
 * is dropped, and the line starts a fresh `<path>`. No kept file exceeds
 * `maxBytes` unless a single line does — an empty file is never rotated, so
 * every record is written. Appends are synchronous, so lines land in the order
 * they were logged. The parent directory is created on the first write.
 *
 * Never throws: a failed append or rotation step is swallowed and the logger
 * keeps accepting records. The file's size is read once, on the first write, and
 * tracked in memory afterwards, so this logger must be the file's only writer.
 *
 * @param opts - See {@link RotatingFileLoggerOptions}.
 * @returns A logger bound to `opts.path`.
 *
 * @example
 * ```ts
 * const logger = rotatingFileLogger({
 *   path: '/var/log/firefly/render.log',
 *   maxBytes: 5 * 1024 * 1024,
 *   maxFiles: 3,
 * });
 * ```
 */
export function rotatingFileLogger(opts: RotatingFileLoggerOptions): Logger {
  const { path } = opts;
  const maxBytes = integerOption(opts.maxBytes, DEFAULT_MAX_BYTES, 1);
  const maxFiles = integerOption(opts.maxFiles, DEFAULT_MAX_FILES, 0);
  let size = -1; // unknown until the first write reads it

  return {
    log(record) {
      try {
        const line = `${JSON.stringify(record)}\n`;
        const bytes = Buffer.byteLength(line);
        if (size < 0) {
          mkdirSync(dirname(path), { recursive: true });
          size = fileSize(path);
        }
        if (size > 0 && size + bytes > maxBytes) {
          rotate(path, maxFiles);
          size = fileSize(path);
        }
        appendFileSync(path, line);
        size += bytes;
      } catch {
        // A logging failure must never reach the caller.
      }
    },
  };
}

/** `value` floored to an integer no smaller than `min`, or `fallback` when `value` is not a finite number. */
function integerOption(value: number | undefined, fallback: number, min: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.floor(value))
    : fallback;
}

/** The byte size of the file at `path`, or `0` when there is no file there. */
function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Shifts `<path>` → `<path>.1` → … → `<path>.<maxFiles>`: each rename replaces
 * an existing target, so the copy at `<path>.<maxFiles>` is overwritten by the
 * one behind it and the oldest copy is dropped. With `maxFiles` of `0` the
 * current file is deleted instead. Each step tolerates its own failure so one
 * stuck file does not stop the rest of the shift or the write that follows.
 */
function rotate(path: string, maxFiles: number): void {
  if (maxFiles === 0) {
    attempt(() => unlinkSync(path));
    return;
  }
  for (let i = maxFiles - 1; i >= 1; i -= 1) {
    attempt(() => renameSync(`${path}.${i}`, `${path}.${i + 1}`));
  }
  attempt(() => renameSync(path, `${path}.1`));
}

/** Runs `fn`, swallowing whatever it throws — for a file operation whose target may not exist. */
function attempt(fn: () => void): void {
  try {
    fn();
  } catch {
    // Nothing to do when the target is absent or busy.
  }
}

/**
 * A caller's `logging` option: omit it (or pass `true`) for the default stdout
 * NDJSON logger, `false` to log nothing, or a {@link Logger} to route records
 * elsewhere.
 */
export type LoggingOption = boolean | Logger | undefined;

/**
 * Resolves a {@link LoggingOption} to the sink {@link emit} writes to:
 * `undefined` and `true` give a {@link stdoutJsonLogger}; `false` gives `null`
 * (nothing is logged); a {@link Logger} is returned as-is. Logging is opt-out —
 * an omitted option means on. Keep it that way: a silent default collects
 * nothing.
 *
 * @example
 * ```ts
 * resolveLogger(undefined); // stdout NDJSON logger — the default
 * resolveLogger(false); // null — logging disabled
 * resolveLogger({ log: (record) => pino.info(record) }); // that same object
 * ```
 */
export function resolveLogger(opt: LoggingOption): Logger | null {
  if (opt === false) return null;
  if (opt === undefined || opt === true) return stdoutJsonLogger();
  return opt;
}

/**
 * What a capability knows when a call settles — the input to {@link buildLogRecord}.
 */
export interface BuildLogRecordInput {
  /** Defaults to `'error'` when `error` is set, else `'info'`. */
  level?: LogLevel;
  /** See {@link LogRecord.msg}. */
  msg: string;
  /** See {@link LogRecord.endpoint}. */
  endpoint: string;
  /** See {@link LogRecord.jobId}. Defaults to `meta.jobId` when `meta` carries one. */
  jobId?: string;
  /** The job's derived timing; its `queueMs`/`renderMs`/`totalMs` become the record's flat timing fields. */
  meta?: JobMeta;
  /** See {@link LogRecord.preset}. */
  preset?: string;
  /** See {@link LogRecord.codec}. */
  codec?: string;
  /** See {@link LogRecord.resolution}. */
  resolution?: string;
  /** See {@link LogRecord.totalJobItems}. */
  totalJobItems?: number;
  /** See {@link LogRecord.status}. */
  status?: string;
  /** The failure that settled the call, if any — rendered to {@link LogRecord.error}. */
  error?: unknown;
}

/**
 * Builds a flat {@link LogRecord} from what a capability knows when a call
 * settles. `time` is the current instant as ISO-8601; `level` defaults to
 * `'error'` when `error` is set and `'info'` otherwise; `meta`'s
 * `queueMs`/`renderMs`/`totalMs` are copied to the record's flat timing fields
 * (a non-finite duration is left out); `error` is rendered to one redacted
 * string — an {@link AudioVideoError} as `code: message`, any other `Error` as
 * `name: message`, anything else via `String()`. A field with no value is left
 * out of the record rather than set to `undefined`.
 *
 * @example
 * ```ts
 * emit(
 *   logger,
 *   buildLogRecord({
 *     msg: 'render completed',
 *     endpoint: 'POST /v1/templates/render',
 *     meta: job.meta,
 *     status: 'succeeded',
 *     totalJobItems: 3,
 *   }),
 * );
 * ```
 */
export function buildLogRecord(input: BuildLogRecordInput): LogRecord {
  const record: LogRecord = {
    time: new Date().toISOString(),
    level: input.level ?? (input.error === undefined ? 'info' : 'error'),
    msg: input.msg,
    endpoint: input.endpoint,
  };
  setString(record, 'jobId', input.jobId ?? nonEmpty(input.meta?.jobId));
  setNumber(record, 'queueMs', input.meta?.queueMs);
  setNumber(record, 'renderMs', input.meta?.renderMs);
  setNumber(record, 'totalMs', input.meta?.totalMs);
  setString(record, 'preset', input.preset);
  setString(record, 'codec', input.codec);
  setString(record, 'resolution', input.resolution);
  setNumber(record, 'totalJobItems', input.totalJobItems);
  setString(record, 'status', input.status);
  if (input.error !== undefined) record.error = renderError(input.error);
  return record;
}

type StringField = 'jobId' | 'preset' | 'codec' | 'resolution' | 'status';
type NumberField = 'queueMs' | 'renderMs' | 'totalMs' | 'totalJobItems';

/** Sets `record[key]` when `value` is defined; leaves the key absent otherwise. */
function setString(record: LogRecord, key: StringField, value: string | undefined): void {
  if (value !== undefined) record[key] = value;
}

/** Sets `record[key]` when `value` is a finite number; leaves the key absent otherwise. */
function setNumber(record: LogRecord, key: NumberField, value: number | undefined): void {
  if (typeof value === 'number' && Number.isFinite(value)) record[key] = value;
}

/** `value` itself, or `undefined` for an empty or missing string. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * Renders a settled call's failure to one redacted string: an
 * {@link AudioVideoError} as `code: message`, any other `Error` as
 * `name: message`, anything else via `String()`. Never throws — a value that
 * cannot be stringified renders as a fixed placeholder.
 */
function renderError(error: unknown): string {
  let text: string;
  if (error instanceof AudioVideoError) {
    text = `${error.code}: ${error.message}`;
  } else if (error instanceof Error) {
    text = `${error.name}: ${error.message}`;
  } else {
    try {
      text = String(error);
    } catch {
      text = '[unrenderable error]';
    }
  }
  return redactValue(text);
}

/**
 * The single dispatch path for every record the SDK logs. Redacts `record`
 * through {@link redactValue} into a new object (`record` itself is not
 * modified), hands that to `logger.log`, and swallows anything `log` throws —
 * so a sink only ever receives a redacted record, and a failing sink never
 * breaks the call being logged. A sink's first failure is reported once on
 * `process.stderr`; later failures of the same sink are silent. A `null`
 * `logger` (logging disabled) is a no-op.
 *
 * @param logger - The sink from {@link resolveLogger}, or `null` when logging is off.
 * @param record - The record to write; see {@link buildLogRecord}.
 */
export function emit(logger: Logger | null, record: LogRecord): void {
  if (!logger) return;
  const safe = redactValue(record) as LogRecord;
  try {
    logger.log(safe);
  } catch (err) {
    reportSinkFailure(logger, err);
  }
}

/** Sinks whose first failure has already been reported on stderr. */
const reportedSinks = new WeakSet<Logger>();

/** Writes one stderr line the first time a given sink's `log` throws. Never throws itself. */
function reportSinkFailure(logger: Logger, err: unknown): void {
  if (reportedSinks.has(logger)) return;
  reportedSinks.add(logger);
  try {
    process.stderr.write(
      `firefly-audio-video: logger sink threw (${renderError(err)}); further failures from this sink are not reported\n`,
    );
  } catch {
    // stderr is unavailable too; there is nowhere left to report to.
  }
}
