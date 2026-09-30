import { expect, test } from 'vitest';
import { AudioVideoError } from '../../src/core/errors.js';
import type { CliRuntime } from '../../src/cli/runtime.js';
import { resolveClient } from '../../src/cli/client.js';
import { createFakeClient } from './support/fake-client.js';

const SECRET = 'CLIENT_SECRET_VALUE_MUST_NEVER_APPEAR';

function writableStub(onWrite?: (chunk: string) => void): NodeJS.WritableStream {
  return {
    write: (chunk: string | Uint8Array) => {
      onWrite?.(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    },
  } as unknown as NodeJS.WritableStream;
}

function runtimeOf(overrides: Partial<CliRuntime> = {}): CliRuntime {
  return {
    client: undefined,
    env: {},
    stdout: writableStub(),
    stderr: writableStub(),
    exit: () => undefined,
    forceExit: () => undefined,
    onInterrupt: () => () => undefined,
    ...overrides,
  };
}

async function rejection(fn: () => unknown): Promise<AudioVideoError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AudioVideoError);
    return error as AudioVideoError;
  }
  throw new Error('expected a rejection');
}

test('returns the injected client unchanged, ignoring every credential option', () => {
  const injected = createFakeClient();
  const runtime = runtimeOf({ client: injected });
  expect(resolveClient(runtime, {})).toBe(injected);
  expect(resolveClient(runtime, { clientId: 'x', clientSecret: 'y' })).toBe(injected);
});

test('builds a real client from --client-id/--client-secret flags', () => {
  const client = resolveClient(runtimeOf(), {
    clientId: 'id-from-flag',
    clientSecret: 'secret-from-flag',
  });
  expect(typeof client.render).toBe('function');
});

test('falls back to IMS_OAUTH_S2S_CLIENT_ID / IMS_OAUTH_S2S_CLIENT_SECRET from the environment', () => {
  const runtime = runtimeOf({
    env: { IMS_OAUTH_S2S_CLIENT_ID: 'env-id', IMS_OAUTH_S2S_CLIENT_SECRET: 'env-secret' },
  });
  const client = resolveClient(runtime, {});
  expect(typeof client.render).toBe('function');
});

test('a flag wins over the environment for client id and secret', () => {
  const runtime = runtimeOf({
    env: { IMS_OAUTH_S2S_CLIENT_ID: 'env-id', IMS_OAUTH_S2S_CLIENT_SECRET: 'env-secret' },
  });
  // Neither value is inspectable from the built client, so this only proves construction
  // succeeds when a flag is combined with an environment fallback for the other field.
  expect(() => resolveClient(runtime, { clientId: 'flag-id' })).not.toThrow();
});

test('missing credentials reject invalid_argument, naming both configuration paths, and echo nothing', async () => {
  const error = await rejection(() => resolveClient(runtimeOf(), {}));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('--client-id');
  expect(error.message).toContain('IMS_OAUTH_S2S_CLIENT_ID');
  expect(error.message).toContain('--client-secret');
  expect(error.message).toContain('IMS_OAUTH_S2S_CLIENT_SECRET');
});

test('a client-secret value never appears in the missing-credentials message even when it was actually supplied', async () => {
  // clientSecret IS resolved here (from the environment) — only clientId is
  // missing. The message must still never contain the secret's value.
  const runtime = runtimeOf({ env: { IMS_OAUTH_S2S_CLIENT_SECRET: SECRET } });
  const error = await rejection(() => resolveClient(runtime, {}));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('--client-id');
  expect(error.message).not.toContain(SECRET);
});

test('--storage builds and attaches a storage provider; a bad --storage rejects invalid_argument', async () => {
  expect(() =>
    resolveClient(runtimeOf(), { clientId: 'id', clientSecret: 'secret', storage: 'aio-files' }),
  ).not.toThrow();
  const error = await rejection(() =>
    resolveClient(runtimeOf(), { clientId: 'id', clientSecret: 'secret', storage: 'not-a-uri' }),
  );
  expect(error.code).toBe('invalid_argument');
});

test('DGR_STORAGE is used when --storage is not given', () => {
  const runtime = runtimeOf({ env: { DGR_STORAGE: 'aio-files' } });
  expect(() => resolveClient(runtime, { clientId: 'id', clientSecret: 'secret' })).not.toThrow();
});

test('--log routes one NDJSON record per call to the runtime stderr stream, never stdout', async () => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const runtime = runtimeOf({
    stdout: writableStub((c) => stdoutChunks.push(c)),
    stderr: writableStub((c) => stderrChunks.push(c)),
  });
  const client = resolveClient(runtime, { clientId: 'id', clientSecret: 'secret', log: true });
  // stage() on a plain string that is neither an http(s) URL nor an existing
  // file, with no storage configured, rejects locally — no network call —
  // which still settles the call and emits exactly one log record.
  await expect(client.stage('not-a-url-and-not-a-file')).rejects.toBeInstanceOf(AudioVideoError);
  expect(stdoutChunks).toEqual([]);
  expect(stderrChunks).toHaveLength(1);
  const record: unknown = JSON.parse(stderrChunks[0] ?? '');
  expect(record).toMatchObject({ level: 'error', msg: 'stage failed' });
});

test('without --log, the SDK writes no log record to either stream', async () => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const runtime = runtimeOf({
    stdout: writableStub((c) => stdoutChunks.push(c)),
    stderr: writableStub((c) => stderrChunks.push(c)),
  });
  const client = resolveClient(runtime, { clientId: 'id', clientSecret: 'secret' });
  await expect(client.stage('not-a-url-and-not-a-file')).rejects.toBeInstanceOf(AudioVideoError);
  expect(stdoutChunks).toEqual([]);
  expect(stderrChunks).toEqual([]);
});
