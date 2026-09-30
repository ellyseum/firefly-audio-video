import { expect, test, vi } from 'vitest';
import { AudioVideoError } from '../../src/core/errors.js';
import type { JobStatusLike } from '../../src/core/job.js';
import { createFakeClient } from './support/fake-client.js';
import { createHarness } from './support/harness.js';

const ACK: JobStatusLike = { jobId: 'job-1', status: 'canceling' };

test('human mode prints the acknowledgement as indented JSON and exits 0', async () => {
  const client = createFakeClient({
    cancel: vi.fn(async (jobId: string) => {
      expect(jobId).toBe('job-1');
      return ACK;
    }),
  });
  const harness = createHarness({ client });
  await harness.run(['cancel', 'job-1']);
  expect(JSON.parse(harness.stdoutText())).toEqual(ACK);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test('--json mode wraps the acknowledgement under job', async () => {
  const client = createFakeClient({ cancel: vi.fn(async () => ACK) });
  const harness = createHarness({ client });
  await harness.run(['cancel', 'job-1', '--json']);
  expect(JSON.parse(harness.stdoutText().trim())).toEqual({ ok: true, job: ACK });
});

test('cancelling a finished job maps http_409 to exit 5', async () => {
  const failure = new AudioVideoError({ message: 'job already finished', code: 'http_409' });
  const client = createFakeClient({ cancel: vi.fn(async () => Promise.reject(failure)) });
  const harness = createHarness({ client });
  await harness.run(['cancel', 'job-1']);
  expect(harness.stderrText()).toBe('Error: job already finished\nCode: http_409\n');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(5);
});

test('--json mode failure', async () => {
  const failure = new AudioVideoError({ message: 'job not found', code: 'http_404' });
  const client = createFakeClient({ cancel: vi.fn(async () => Promise.reject(failure)) });
  const harness = createHarness({ client });
  await harness.run(['cancel', 'job-1', '--json']);
  expect(JSON.parse(harness.stdoutText().trim())).toEqual({
    ok: false,
    error: { code: 'http_404', message: 'job not found' },
  });
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(5);
});
