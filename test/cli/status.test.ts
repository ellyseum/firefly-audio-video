import { expect, test, vi } from 'vitest';
import { AudioVideoError } from '../../src/core/errors.js';
import type { JobStatusLike } from '../../src/core/job.js';
import { createFakeClient } from './support/fake-client.js';
import { createHarness } from './support/harness.js';

const STATUS: JobStatusLike = { jobId: 'job-1', status: 'succeeded', outputs: [] };

test('human mode prints the raw status body as indented JSON and exits 0', async () => {
  const client = createFakeClient({
    status: vi.fn(async (jobId: string) => {
      expect(jobId).toBe('job-1');
      return STATUS;
    }),
  });
  const harness = createHarness({ client });
  await harness.run(['status', 'job-1']);
  expect(JSON.parse(harness.stdoutText())).toEqual(STATUS);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test('--json mode wraps the status body under job, as exactly one document', async () => {
  const client = createFakeClient({ status: vi.fn(async () => STATUS) });
  const harness = createHarness({ client });
  await harness.run(['status', 'job-1', '--json']);
  const lines = harness
    .stdoutText()
    .split('\n')
    .filter((line) => line !== '');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? '')).toEqual({ ok: true, job: STATUS });
});

test('failure maps to the error family exit code, human mode', async () => {
  const failure = new AudioVideoError({ message: 'job not found', code: 'http_404' });
  const client = createFakeClient({ status: vi.fn(async () => Promise.reject(failure)) });
  const harness = createHarness({ client });
  await harness.run(['status', 'missing-job']);
  expect(harness.stderrText()).toBe('Error: job not found\nCode: http_404\n');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(5);
});

test('failure maps to the error family exit code, --json mode', async () => {
  const failure = new AudioVideoError({ message: 'not authorized', code: 'auth_failed' });
  const client = createFakeClient({ status: vi.fn(async () => Promise.reject(failure)) });
  const harness = createHarness({ client });
  await harness.run(['status', 'job-1', '--json']);
  expect(JSON.parse(harness.stdoutText().trim())).toEqual({
    ok: false,
    error: { code: 'auth_failed', message: 'not authorized' },
  });
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(3);
});

test('a failure with only a request ID carries just that ID in the --json document', async () => {
  const failure = new AudioVideoError({
    message: 'job not found',
    code: 'http_404',
    requestId: 'req-404',
  });
  const client = createFakeClient({ status: vi.fn(async () => Promise.reject(failure)) });
  const harness = createHarness({ client });
  await harness.run(['status', 'missing-job', '--json']);
  expect(JSON.parse(harness.stdoutText().trim())).toEqual({
    ok: false,
    error: { code: 'http_404', message: 'job not found', requestId: 'req-404' },
  });
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(5);
});

test('a missing jobId argument is a commander usage error, exit 2', async () => {
  const harness = createHarness({ client: createFakeClient() });
  await harness.run(['status']);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});

const WRITE_SIGNATURE = 'STATUS_WRITE_SIG_MUST_NOT_PRINT';
const OUTPUT_PATH = 'https://acct.blob.core.windows.net/c/out.mov';

/** A status body as the live API sends it: each output echoes the presigned write URL it was given. */
const SIGNED_STATUS = {
  jobId: 'job-1',
  status: 'succeeded',
  outputs: [
    {
      destination: { url: `${OUTPUT_PATH}?sv=2021&sp=cw&se=2026&sig=${WRITE_SIGNATURE}` },
      variationIndex: '0',
      presetIndex: '0',
    },
  ],
};

/** {@link SIGNED_STATUS} with its write URL's signing parameters removed. */
const REDACTED_STATUS = {
  ...SIGNED_STATUS,
  outputs: [{ destination: { url: OUTPUT_PATH }, variationIndex: '0', presetIndex: '0' }],
};

test("human mode prints an output's write URL without its signature", async () => {
  const client = createFakeClient({ status: vi.fn(async () => SIGNED_STATUS) });
  const harness = createHarness({ client });
  await harness.run(['status', 'job-1']);
  expect(harness.stdoutText()).not.toContain(WRITE_SIGNATURE);
  expect(JSON.parse(harness.stdoutText())).toEqual(REDACTED_STATUS);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test("--json mode prints an output's write URL without its signature", async () => {
  const client = createFakeClient({ status: vi.fn(async () => SIGNED_STATUS) });
  const harness = createHarness({ client });
  await harness.run(['status', 'job-1', '--json']);
  expect(harness.stdoutText()).not.toContain(WRITE_SIGNATURE);
  expect(JSON.parse(harness.stdoutText().trim())).toEqual({ ok: true, job: REDACTED_STATUS });
});

test("a failed request's response body reaches the --json document, and its reason the error line", async () => {
  const body = { error_code: '403003', message: 'Api Key is invalid' };
  const failure = new AudioVideoError({
    message: 'Request to https://audio-video-api.adobe.io/v1/status/job-1 failed with status 403.',
    code: 'http_403',
    status: 403,
    items: [body],
  });
  const client = createFakeClient({ status: vi.fn(async () => Promise.reject(failure)) });

  const human = createHarness({ client });
  await human.run(['status', 'job-1']);
  expect(human.stderrText()).toBe(
    'Error: Request to https://audio-video-api.adobe.io/v1/status/job-1 failed with status 403. ' +
      'Reason: 403003: Api Key is invalid\nCode: http_403\n',
  );

  const json = createHarness({ client });
  await json.run(['status', 'job-1', '--json']);
  expect(JSON.parse(json.stdoutText().trim())).toEqual({
    ok: false,
    error: { code: 'http_403', message: failure.message, items: [body] },
  });
  expect(json.exit).toHaveBeenCalledExactlyOnceWith(5);
});
