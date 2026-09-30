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

test('a missing jobId argument is a commander usage error, exit 2', async () => {
  const harness = createHarness({ client: createFakeClient() });
  await harness.run(['status']);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});
