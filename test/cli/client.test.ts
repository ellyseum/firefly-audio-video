import { expect, test, vi } from 'vitest';
import { AudioVideoError } from '../../src/core/errors.js';
import type { CliRuntime } from '../../src/cli/runtime.js';
import { resolveClient, resolveCredentials } from '../../src/cli/client.js';
import { MockApi } from '../support/mock-api.js';
import { createFakeClient } from './support/fake-client.js';
import { createHarness } from './support/harness.js';

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

const CREDENTIAL_ENV = {
  IMS_OAUTH_S2S_CLIENT_ID: 'env-id',
  IMS_OAUTH_S2S_CLIENT_SECRET: 'env-secret',
  IMS_OAUTH_S2S_SCOPES: 'env-scope',
};

test('each credential flag wins over its environment variable, one at a time', () => {
  expect(resolveCredentials(CREDENTIAL_ENV, { clientId: 'flag-id' })).toEqual({
    clientId: 'flag-id',
    clientSecret: 'env-secret',
    scope: 'env-scope',
  });
  expect(resolveCredentials(CREDENTIAL_ENV, { clientSecret: 'flag-secret' })).toEqual({
    clientId: 'env-id',
    clientSecret: 'flag-secret',
    scope: 'env-scope',
  });
  expect(resolveCredentials(CREDENTIAL_ENV, { scope: 'flag-scope' })).toEqual({
    clientId: 'env-id',
    clientSecret: 'env-secret',
    scope: 'flag-scope',
  });
});

test('a blank credential flag falls back to its environment variable; with neither set, scope is absent', () => {
  expect(
    resolveCredentials(CREDENTIAL_ENV, { clientId: ' ', clientSecret: '', scope: '  ' }),
  ).toEqual({ clientId: 'env-id', clientSecret: 'env-secret', scope: 'env-scope' });
  expect(
    resolveCredentials({}, { clientId: 'flag-id', clientSecret: 'flag-secret' }),
  ).toStrictEqual({ clientId: 'flag-id', clientSecret: 'flag-secret' });
});

test('a real client sends the flag credentials, not the environment ones, to IMS and the API', async () => {
  const api = new MockApi();
  api.ims();
  api.reply('GET', '/v1/status/job-1', 200, { jobId: 'job-1', status: 'succeeded' });
  try {
    const harness = createHarness({ env: CREDENTIAL_ENV });
    await harness.run([
      'status',
      'job-1',
      '--client-id',
      'flag-id',
      '--client-secret',
      'flag-secret',
      '--scope',
      'flag-scope',
    ]);
    expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
    const forms = api.imsRequests();
    expect(forms).toHaveLength(1);
    expect(forms[0]?.get('client_id')).toBe('flag-id');
    expect(forms[0]?.get('client_secret')).toBe('flag-secret');
    expect(forms[0]?.get('scope')).toBe('flag-scope');
    const status = api.calls.find((call) => call.path === '/v1/status/job-1');
    expect(status?.headers['x-api-key']).toBe('flag-id');
  } finally {
    await api.close();
  }
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

test('with storage needed, --storage builds a storage provider and a bad one rejects invalid_argument', async () => {
  const needs = { storage: true };
  expect(() =>
    resolveClient(
      runtimeOf(),
      { clientId: 'id', clientSecret: 'secret', storage: 'aio-files' },
      needs,
    ),
  ).not.toThrow();
  const error = await rejection(() =>
    resolveClient(
      runtimeOf(),
      { clientId: 'id', clientSecret: 'secret', storage: 'not-a-uri' },
      needs,
    ),
  );
  expect(error.code).toBe('invalid_argument');
});

test('with storage needed, a bad DGR_STORAGE rejects invalid_argument when --storage is not given', async () => {
  const runtime = runtimeOf({ env: { DGR_STORAGE: 'not-a-uri' } });
  const error = await rejection(() =>
    resolveClient(runtime, { clientId: 'id', clientSecret: 'secret' }, { storage: true }),
  );
  expect(error.code).toBe('invalid_argument');
});

test('without storage needed, neither --storage nor DGR_STORAGE is read', () => {
  const runtime = runtimeOf({ env: { DGR_STORAGE: 'not-a-uri' } });
  expect(() =>
    resolveClient(runtime, { clientId: 'id', clientSecret: 'secret', storage: 'not-a-uri' }),
  ).not.toThrow();
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

test('without --log, the SDK writes no log record to the runtime streams or the process stdout', async () => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const runtime = runtimeOf({
    stdout: writableStub((c) => stdoutChunks.push(c)),
    stderr: writableStub((c) => stderrChunks.push(c)),
  });
  const processStdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const client = resolveClient(runtime, { clientId: 'id', clientSecret: 'secret' });
    await expect(client.stage('not-a-url-and-not-a-file')).rejects.toBeInstanceOf(AudioVideoError);
    expect(processStdout).not.toHaveBeenCalled();
  } finally {
    processStdout.mockRestore();
  }
  expect(stdoutChunks).toEqual([]);
  expect(stderrChunks).toEqual([]);
});
