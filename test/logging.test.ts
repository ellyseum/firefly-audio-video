import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { AudioVideoError } from '../src/core/errors.js';
import type { JobMeta } from '../src/core/job.js';
import {
  buildLogRecord,
  emit,
  resolveLogger,
  rotatingFileLogger,
  stdoutJsonLogger,
} from '../src/core/logging.js';
import type { LogRecord, Logger } from '../src/core/logging.js';

const SAS_URL = 'https://x.blob.core.windows.net/f?sv=2021&sig=SECRET&se=2026';
const SCRUBBED_URL = 'https://x.blob.core.windows.net/f';
const NOW = '2026-09-29T12:00:00.000Z';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory under the OS temp dir, removed after the test. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'firefly-audio-video-log-'));
  tempDirs.push(dir);
  return dir;
}

/** A writable that captures everything written to it, synchronously. */
function capture(): { stream: Writable; raw: () => string } {
  let out = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      out += String(chunk);
      callback();
    },
  });
  return { stream, raw: () => out };
}

function record(overrides: Partial<LogRecord> = {}): LogRecord {
  return { time: NOW, level: 'info', msg: 'render completed', ...overrides };
}

/** `logger`, asserting it is not null. */
function must(logger: Logger | null): Logger {
  if (logger === null) throw new Error('expected a logger');
  return logger;
}

/** True when no top-level value of `obj` is an object or an array (`null` counts as flat). */
function isFlat(obj: object): boolean {
  return Object.values(obj).every((v) => v === null || typeof v !== 'object');
}

/** Every NDJSON line of the file at `path`, parsed. */
function readLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The `record N` indices logged to the file at `path`, in file order. */
function indices(path: string): number[] {
  return readLines(path).map((line) => Number(String(line.msg).replace('record ', '')));
}

// --- stdoutJsonLogger ----------------------------------------------------------------

test('stdoutJsonLogger: exactly one newline-terminated JSON line per record, parseable and flat', () => {
  const { stream, raw } = capture();
  const logger = stdoutJsonLogger({ stream });

  logger.log(record({ msg: 'one', jobId: 'j1', totalMs: 4600 }));
  logger.log(record({ msg: 'two', level: 'warn' }));
  logger.log(record({ msg: 'three', level: 'error', error: 'http_500: boom' }));

  const out = raw();
  expect(out.endsWith('\n')).toBe(true);
  expect(out.split('\n')).toHaveLength(4); // three lines, then the empty tail after the last newline
  const parsed = out
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(parsed.map((p) => p.msg)).toEqual(['one', 'two', 'three']);
  expect(parsed[0]).toEqual({ time: NOW, level: 'info', msg: 'one', jobId: 'j1', totalMs: 4600 });
  for (const p of parsed) expect(isFlat(p)).toBe(true);
});

test('stdoutJsonLogger: defaults to process.stdout', () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  stdoutJsonLogger().log(record({ msg: 'to stdout' }));

  expect(write).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith(`${JSON.stringify(record({ msg: 'to stdout' }))}\n`);
});

// --- resolveLogger -------------------------------------------------------------------

test('resolveLogger: undefined resolves to the stdout logger — logging is on by default', () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  const logger = resolveLogger(undefined);

  expect(logger).not.toBeNull();
  must(logger).log(record({ msg: 'default on' }));
  expect(write).toHaveBeenCalledTimes(1);
  expect(String(write.mock.calls[0]?.[0])).toContain('"msg":"default on"');
});

test('resolveLogger: true resolves to the stdout logger, false to null, a Logger to itself', () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  must(resolveLogger(true)).log(record({ msg: 'explicit on' }));
  expect(write).toHaveBeenCalledTimes(1);

  expect(resolveLogger(false)).toBeNull();

  const custom: Logger = { log: vi.fn() };
  expect(resolveLogger(custom)).toBe(custom);
});

test("resolveLogger: 'warn' drops info and writes warn/error; a custom Logger is never filtered", () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const logger = must(resolveLogger('warn'));

  logger.log(record({ msg: 'dropped', level: 'info' }));
  logger.log(record({ msg: 'kept warn', level: 'warn' }));
  logger.log(record({ msg: 'kept error', level: 'error' }));

  expect(write).toHaveBeenCalledTimes(2);
  expect(String(write.mock.calls[0]?.[0])).toContain('"msg":"kept warn"');
  expect(String(write.mock.calls[1]?.[0])).toContain('"msg":"kept error"');

  const seenLevels: string[] = [];
  const custom: Logger = { log: (r) => seenLevels.push(r.level) };
  must(resolveLogger(custom)).log(record({ level: 'info' }));
  expect(seenLevels).toEqual(['info']); // a supplied Logger is returned as-is, unfiltered
});

test("resolveLogger: 'error' writes only error records", () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const logger = must(resolveLogger('error'));

  logger.log(record({ msg: 'dropped info', level: 'info' }));
  logger.log(record({ msg: 'dropped warn', level: 'warn' }));
  logger.log(record({ msg: 'kept', level: 'error' }));

  expect(write).toHaveBeenCalledTimes(1);
  expect(String(write.mock.calls[0]?.[0])).toContain('"msg":"kept"');
});

test("resolveLogger: 'info' drops nothing — the same behavior as the default", () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  must(resolveLogger('info')).log(record({ msg: 'kept', level: 'info' }));

  expect(write).toHaveBeenCalledTimes(1);
});

test('resolveLogger: an unrecognized option throws invalid_argument naming the accepted forms', () => {
  const bogusValues: unknown[] = ['nope', 1, {}];

  for (const bogus of bogusValues) {
    let caught: unknown;
    try {
      resolveLogger(bogus as never);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AudioVideoError);
    const err = caught as AudioVideoError;
    expect(err.code).toBe('invalid_argument');
    expect(err.message).toContain("'info' | 'warn' | 'error'");
    expect(err.message).toContain('Logger');
  }
});

// --- emit -------------------------------------------------------------------------------

test('emit: a SAS URL in any field is redacted before the sink sees the record; the caller record is untouched', () => {
  const log = vi.fn<(r: LogRecord) => void>();
  const original = record({
    msg: `render failed for ${SAS_URL}`,
    endpoint: SAS_URL,
    preset: SAS_URL,
    status: `see ${SAS_URL}`,
    error: `http_403: Request to ${SAS_URL} failed`,
  });
  const before = JSON.stringify(original);

  emit({ log }, original);

  expect(log).toHaveBeenCalledTimes(1);
  const received = log.mock.calls[0]?.[0];
  const serialized = JSON.stringify(received);
  expect(serialized).not.toContain('SECRET');
  expect(serialized).not.toContain('sig=');
  expect(serialized).toContain(SCRUBBED_URL); // the URL is scrubbed, not dropped
  expect(received).not.toBe(original);
  expect(JSON.stringify(original)).toBe(before);
  expect(before).toContain('SECRET');
});

test('emit + stdoutJsonLogger: the written line carries no secret', () => {
  const { stream, raw } = capture();

  emit(stdoutJsonLogger({ stream }), record({ msg: SAS_URL, error: SAS_URL }));

  expect(raw()).not.toContain('SECRET');
  expect(raw()).not.toContain('sig=');
  expect(JSON.parse(raw().trim())).toEqual(record({ msg: SCRUBBED_URL, error: SCRUBBED_URL }));
});

test('emit: a null logger is a no-op', () => {
  expect(() => emit(null, record({ msg: SAS_URL }))).not.toThrow();
});

test('emit: a sink that throws never propagates, and is reported on stderr once per sink', () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const failing: Logger = {
    log() {
      throw new Error(`disk full while writing ${SAS_URL}`);
    },
  };

  expect(() => emit(failing, record())).not.toThrow();
  expect(() => emit(failing, record())).not.toThrow();
  expect(() => emit(failing, record())).not.toThrow();

  expect(stderr).toHaveBeenCalledTimes(1);
  const report = String(stderr.mock.calls[0]?.[0]);
  expect(report).toContain('logger sink threw');
  expect(report).toContain('disk full');
  expect(report).not.toContain('SECRET');
  expect(report.endsWith('\n')).toBe(true);

  const anotherFailing: Logger = {
    log() {
      throw 'not even an Error';
    },
  };
  expect(() => emit(anotherFailing, record())).not.toThrow();
  expect(stderr).toHaveBeenCalledTimes(2);
  expect(String(stderr.mock.calls[1]?.[0])).toContain('not even an Error');
});

test('emit: a sink failure is still swallowed when stderr itself throws', () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => {
    throw new Error('stderr gone');
  });
  const failing: Logger = {
    log() {
      throw new Error('sink broke');
    },
  };

  expect(() => emit(failing, record())).not.toThrow();
});

test('emit: a record whose own property access throws still reaches the sink, that field unreadable, and never propagates', () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const sink = vi.fn();
  const poisoned = {
    time: NOW,
    level: 'info',
    get msg(): string {
      throw new Error('accessor boom');
    },
  } as unknown as LogRecord;

  expect(() => emit({ log: sink }, poisoned)).not.toThrow();
  expect(sink).toHaveBeenCalledTimes(1);
  expect(sink.mock.calls[0]?.[0]).toEqual({ time: NOW, level: 'info', msg: '[Unreadable]' });
  // The sink did not fail, so nothing reports that it did.
  expect(stderr).not.toHaveBeenCalled();
});

test('emit: a logging option that bypassed resolveLogger validation cannot make emit throw', () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  expect(() => emit(1 as unknown as Logger, record())).not.toThrow();
  expect(() => emit(1 as unknown as Logger, record())).not.toThrow();

  expect(stderr).toHaveBeenCalledTimes(0); // a non-object logger is not a valid WeakSet key — nothing to report to
});

// --- buildLogRecord ---------------------------------------------------------------------

const META: JobMeta = {
  jobId: 'job-1',
  createdAt: Date.parse(NOW),
  queueMs: 1200,
  renderMs: 3400,
  totalMs: 4600,
  perItem: [{ index: 0, queueMs: 1200, renderMs: 3400, totalMs: 4600 }],
};

test('buildLogRecord: maps JobMeta timing into flat fields, stamps an ISO time, takes jobId from meta', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));

  const rec = buildLogRecord({
    msg: 'render completed',
    endpoint: 'POST /v1/templates/render',
    meta: META,
    preset: 'ffs_video_api_land_1080p_hq',
    codec: 'h264',
    resolution: '1920x1080',
    totalJobItems: 1,
    status: 'succeeded',
  });

  expect(rec).toEqual({
    time: NOW,
    level: 'info',
    msg: 'render completed',
    endpoint: 'POST /v1/templates/render',
    jobId: 'job-1',
    queueMs: 1200,
    renderMs: 3400,
    totalMs: 4600,
    preset: 'ffs_video_api_land_1080p_hq',
    codec: 'h264',
    resolution: '1920x1080',
    totalJobItems: 1,
    status: 'succeeded',
  });
  expect(Object.keys(rec)).not.toContain('perItem');
  expect(Object.keys(rec)).not.toContain('meta');
  expect(isFlat(rec)).toBe(true);
  expect(Number.isFinite(Date.parse(rec.time))).toBe(true);
});

test('buildLogRecord: an explicit jobId wins over meta.jobId, and an empty meta.jobId is omitted', () => {
  const explicit = buildLogRecord({ msg: 'm', endpoint: 'e', jobId: 'explicit', meta: META });
  expect(explicit.jobId).toBe('explicit');

  const blank = buildLogRecord({ msg: 'm', endpoint: 'e', meta: { ...META, jobId: '' } });
  expect(Object.keys(blank)).not.toContain('jobId');
});

test('buildLogRecord: absent fields and non-finite durations are left out, not set to undefined', () => {
  const rec = buildLogRecord({
    msg: 'submitted',
    endpoint: 'POST /v1/templates/render',
    meta: { jobId: 'j', queueMs: Number.NaN, renderMs: Number.POSITIVE_INFINITY, perItem: [] },
    totalJobItems: Number.NaN,
  });

  expect(Object.keys(rec).sort()).toEqual(['endpoint', 'jobId', 'level', 'msg', 'time']);
});

test('buildLogRecord: error renders to one redacted string and defaults level to error', () => {
  const avError = new AudioVideoError({
    message: `Request to ${SAS_URL} failed with status 403.`,
    code: 'http_403',
    status: 403,
  });

  const fromAv = buildLogRecord({ msg: 'render failed', endpoint: 'e', error: avError });
  expect(fromAv.level).toBe('error');
  expect(fromAv.error).toBe(`http_403: Request to ${SCRUBBED_URL} failed with status 403.`);
  expect(fromAv.error).not.toContain('SECRET');

  const fromError = buildLogRecord({
    msg: 'm',
    endpoint: 'e',
    error: new TypeError(`bad ${SAS_URL}`),
  });
  expect(fromError.error).toBe(`TypeError: bad ${SCRUBBED_URL}`);

  const fromString = buildLogRecord({ msg: 'm', endpoint: 'e', error: `plain ${SAS_URL}` });
  expect(fromString.error).toBe(`plain ${SCRUBBED_URL}`);

  const fromNumber = buildLogRecord({ msg: 'm', endpoint: 'e', error: 42 });
  expect(fromNumber.error).toBe('42');

  const warned = buildLogRecord({ msg: 'm', endpoint: 'e', error: avError, level: 'warn' });
  expect(warned.level).toBe('warn');

  expect(buildLogRecord({ msg: 'm', endpoint: 'e' }).level).toBe('info');
});

test('buildLogRecord: never throws on an error value that cannot be stringified', () => {
  const unrenderable = Object.create(null) as object;

  const rec = buildLogRecord({ msg: 'm', endpoint: 'e', error: unrenderable });

  expect(rec.error).toBe('[unrenderable error]');
  expect(rec.level).toBe('error');
});

// --- rotatingFileLogger ------------------------------------------------------------------

test('rotatingFileLogger: rolls at maxBytes, keeps every file within maxBytes, caps copies at maxFiles, drops the oldest lines', () => {
  const path = join(tempDir(), 'render.log');
  const logger = rotatingFileLogger({ path, maxBytes: 200, maxFiles: 2 });

  for (let i = 0; i < 30; i += 1) logger.log(record({ msg: `record ${i}` }));

  expect(existsSync(path)).toBe(true);
  expect(existsSync(`${path}.1`)).toBe(true);
  expect(existsSync(`${path}.2`)).toBe(true);
  expect(existsSync(`${path}.3`)).toBe(false);
  for (const p of [path, `${path}.1`, `${path}.2`]) {
    expect(statSync(p).size).toBeLessThanOrEqual(200);
  }

  // Each kept file holds exactly two ~68-69-byte records (138 B), never one — a
  // size estimate left stale after a rotation would rotate again on every later
  // write and keep only one record per file, which an upper-bound-only check
  // (file exists, size <= 200, ordering) cannot tell apart from this.
  expect(readLines(path)).toHaveLength(2);
  expect(readLines(`${path}.1`)).toHaveLength(2);
  expect(readLines(`${path}.2`)).toHaveLength(2);

  const current = indices(path);
  const older = indices(`${path}.1`);
  const oldest = indices(`${path}.2`);
  expect(current.at(-1)).toBe(29);
  expect(Math.min(...current)).toBeGreaterThan(Math.max(...older));
  expect(Math.min(...older)).toBeGreaterThan(Math.max(...oldest));
  expect(current.length + older.length + oldest.length).toBeGreaterThanOrEqual(6);
});

test('rotatingFileLogger: a single record larger than maxBytes is still written — an empty file never rotates', () => {
  const path = join(tempDir(), 'render.log');
  const logger = rotatingFileLogger({ path, maxBytes: 10, maxFiles: 3 });

  logger.log(record({ msg: 'first' }));
  logger.log(record({ msg: 'second' }));

  expect(readLines(path).map((l) => l.msg)).toEqual(['second']);
  expect(readLines(`${path}.1`).map((l) => l.msg)).toEqual(['first']);
  expect(existsSync(`${path}.2`)).toBe(false);
});

test('rotatingFileLogger: the defaults (10 MiB, 5 copies) do not rotate a handful of records', () => {
  const path = join(tempDir(), 'render.log');
  const logger = rotatingFileLogger({ path });

  for (let i = 0; i < 5; i += 1) logger.log(record({ msg: `record ${i}` }));

  expect(readLines(path)).toHaveLength(5);
  expect(existsSync(`${path}.1`)).toBe(false);
});

test('rotatingFileLogger: maxFiles 0 keeps only the current file', () => {
  const path = join(tempDir(), 'render.log');
  const logger = rotatingFileLogger({ path, maxBytes: 200, maxFiles: 0 });

  for (let i = 0; i < 30; i += 1) logger.log(record({ msg: `record ${i}` }));

  expect(statSync(path).size).toBeLessThanOrEqual(200);
  expect(indices(path).at(-1)).toBe(29);
  expect(existsSync(`${path}.1`)).toBe(false);
});

test('rotatingFileLogger: creates the parent directory on the first write', () => {
  const path = join(tempDir(), 'nested', 'deeper', 'render.log');

  rotatingFileLogger({ path }).log(record());

  expect(readLines(path)).toHaveLength(1);
});

test('rotatingFileLogger: accounts for a file that already exists', () => {
  const path = join(tempDir(), 'render.log');
  const existing = `${'x'.repeat(149)}\n`;
  writeFileSync(path, existing);
  const logger = rotatingFileLogger({ path, maxBytes: 200, maxFiles: 1 });

  logger.log(record({ msg: 'after restart' }));

  expect(readFileSync(`${path}.1`, 'utf8')).toBe(existing);
  expect(readLines(path).map((l) => l.msg)).toEqual(['after restart']);
});

test('rotatingFileLogger: an empty current file is not rotated, so a kept copy is not dropped for nothing', () => {
  const path = join(tempDir(), 'render.log');
  writeFileSync(path, '');
  writeFileSync(`${path}.1`, 'kept\n');
  const logger = rotatingFileLogger({ path, maxBytes: 10, maxFiles: 1 });

  logger.log(record({ msg: 'bigger than maxBytes' }));

  expect(readFileSync(`${path}.1`, 'utf8')).toBe('kept\n');
  expect(readLines(path).map((l) => l.msg)).toEqual(['bigger than maxBytes']);
});

test('rotatingFileLogger: never throws when the path cannot be written', () => {
  const blocker = join(tempDir(), 'not-a-directory');
  writeFileSync(blocker, 'x');
  const logger = rotatingFileLogger({ path: join(blocker, 'render.log') });

  expect(() => logger.log(record())).not.toThrow();
  expect(() => logger.log(record())).not.toThrow();
  expect(existsSync(join(blocker, 'render.log'))).toBe(false);
});

test('rotatingFileLogger: a non-finite maxFiles falls back to the default, and a fractional maxBytes does not break rotation', () => {
  const path = join(tempDir(), 'render.log');
  const logger = rotatingFileLogger({ path, maxBytes: 200.9, maxFiles: Number.NaN });

  for (let i = 0; i < 30; i += 1) logger.log(record({ msg: `record ${i}` }));

  expect(existsSync(`${path}.1`)).toBe(true);
  expect(existsSync(`${path}.5`)).toBe(true);
  expect(existsSync(`${path}.6`)).toBe(false);
  for (const p of [path, `${path}.1`, `${path}.5`]) {
    expect(statSync(p).size).toBeLessThanOrEqual(200);
  }
});

test('rotatingFileLogger: minLevel filters records the same way as stdoutJsonLogger', () => {
  const path = join(tempDir(), 'render.log');
  const logger = rotatingFileLogger({ path, minLevel: 'warn' });

  logger.log(record({ msg: 'dropped', level: 'info' }));
  logger.log(record({ msg: 'kept warn', level: 'warn' }));
  logger.log(record({ msg: 'kept error', level: 'error' }));

  expect(readLines(path).map((l) => l.msg)).toEqual(['kept warn', 'kept error']);
});

test('rotatingFileLogger: a logger that never sees a qualifying record never creates its file', () => {
  const path = join(tempDir(), 'nested', 'render.log');
  const logger = rotatingFileLogger({ path, minLevel: 'error' });

  logger.log(record({ msg: 'dropped', level: 'info' }));
  logger.log(record({ msg: 'also dropped', level: 'warn' }));

  expect(existsSync(path)).toBe(false);
});
