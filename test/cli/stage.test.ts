import { expect, test, vi } from 'vitest';
import { AudioVideoError } from '../../src/core/errors.js';
import { createFakeClient } from './support/fake-client.js';
import { createHarness } from './support/harness.js';

const SECRET = 'STAGE_TEST_SECRET_MUST_NEVER_APPEAR';

test('human mode prints the bare presigned URL to stdout and exits 0', async () => {
  const stage = vi.fn(async (input: unknown) => {
    expect(input).toBe('./logo.png');
    return 'https://storage.example.test/logo.png?sig=abc';
  });
  const harness = createHarness({ client: createFakeClient({ stage }) });
  await harness.run(['stage', './logo.png']);
  expect(harness.stdoutText()).toBe('https://storage.example.test/logo.png?sig=abc\n');
  expect(harness.stderrText()).toBe('');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test('--json mode prints exactly one JSON document with the url field', async () => {
  const client = createFakeClient({
    stage: vi.fn(async () => 'https://storage.example.test/a?sig=z'),
  });
  const harness = createHarness({ client });
  await harness.run(['stage', './a.png', '--json']);
  const lines = harness
    .stdoutText()
    .split('\n')
    .filter((line) => line !== '');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? '')).toEqual({
    ok: true,
    url: 'https://storage.example.test/a?sig=z',
  });
});

test('human mode failure prints the error to stderr and exits with the mapped code', async () => {
  const failure = new AudioVideoError({
    message: 'no storage configured',
    code: 'invalid_argument',
  });
  const client = createFakeClient({ stage: vi.fn(async () => Promise.reject(failure)) });
  const harness = createHarness({ client });
  await harness.run(['stage', './a.png']);
  expect(harness.stdoutText()).toBe('');
  expect(harness.stderrText()).toBe('Error: no storage configured\nCode: invalid_argument\n');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});

test('--json mode failure prints exactly one ok:false document to stdout and exits with the mapped code', async () => {
  const failure = new AudioVideoError({ message: 'storage upload failed', code: 'storage_failed' });
  const client = createFakeClient({ stage: vi.fn(async () => Promise.reject(failure)) });
  const harness = createHarness({ client });
  await harness.run(['stage', './a.png', '--json']);
  const lines = harness
    .stdoutText()
    .split('\n')
    .filter((line) => line !== '');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? '')).toEqual({
    ok: false,
    error: { code: 'storage_failed', message: 'storage upload failed' },
  });
  expect(harness.stderrText()).toBe('');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(5);
});

test('a secret given via --client-secret never appears in any output, even on failure', async () => {
  const failure = new AudioVideoError({ message: 'boom', code: 'storage_failed' });
  const client = createFakeClient({ stage: vi.fn(async () => Promise.reject(failure)) });
  const harness = createHarness({ client });
  await harness.run(['stage', './a.png', '--client-secret', SECRET, '--json']);
  expect(harness.stdoutText()).not.toContain(SECRET);
  expect(harness.stderrText()).not.toContain(SECRET);
});

test('a secret given via IMS_OAUTH_S2S_CLIENT_SECRET never appears in any output', async () => {
  const failure = new AudioVideoError({ message: 'boom', code: 'storage_failed' });
  const client = createFakeClient({ stage: vi.fn(async () => Promise.reject(failure)) });
  const harness = createHarness({ client, env: { IMS_OAUTH_S2S_CLIENT_SECRET: SECRET } });
  await harness.run(['stage', './a.png']);
  expect(harness.stdoutText()).not.toContain(SECRET);
  expect(harness.stderrText()).not.toContain(SECRET);
});
