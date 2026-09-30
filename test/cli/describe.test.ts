import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AudioVideoError } from '../../src/core/errors.js';
import type { TemplateDescription } from '../../src/dgr/describe.js';
import { createFakeClient } from './support/fake-client.js';
import { createHarness } from './support/harness.js';
import { settledJob } from './support/job.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'firefly-audio-video-cli-describe-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DESCRIPTION: TemplateDescription = {
  controls: [{ variableId: '0_0_media', type: 'media' }],
  fonts: [{ name: 'Arial-Bold' }],
};

test('human mode prints controls and fonts as indented JSON and exits 0', async () => {
  const client = createFakeClient({
    describe: vi.fn((source: unknown) => {
      expect(source).toBe('https://example.test/t.mogrt');
      return settledJob({ value: DESCRIPTION });
    }),
  });
  const harness = createHarness({ client });
  await harness.run(['describe', 'https://example.test/t.mogrt']);
  expect(JSON.parse(harness.stdoutText())).toEqual(DESCRIPTION);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test('--json mode prints exactly one document with controls and fonts fields', async () => {
  const client = createFakeClient({ describe: vi.fn(() => settledJob({ value: DESCRIPTION })) });
  const harness = createHarness({ client });
  await harness.run(['describe', 'https://example.test/t.mogrt', '--json']);
  const lines = harness
    .stdoutText()
    .split('\n')
    .filter((line) => line !== '');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? '')).toEqual({
    ok: true,
    controls: DESCRIPTION.controls,
    fonts: DESCRIPTION.fonts,
  });
});

test('a local file is staged first, and describe() runs on the staged URL', async () => {
  const path = join(dir, 't.mogrt');
  writeFileSync(path, 'bytes');
  const stage = vi.fn(async () => 'https://staged.example.test/t.mogrt?sig=z');
  const describe = vi.fn((source: unknown) => {
    expect(source).toBe('https://staged.example.test/t.mogrt?sig=z');
    return settledJob({ value: DESCRIPTION });
  });
  const client = createFakeClient({ stage, describe });
  const harness = createHarness({ client });
  await harness.run(['describe', path]);
  expect(stage).toHaveBeenCalledWith(path);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test('failure maps to the invalid_preset family, exit 2', async () => {
  const failure = new AudioVideoError({ message: 'unreadable template', code: 'invalid_argument' });
  const client = createFakeClient({ describe: vi.fn(() => settledJob({ error: failure })) });
  const harness = createHarness({ client });
  await harness.run(['describe', 'https://example.test/t.mogrt']);
  expect(harness.stderrText()).toBe('Error: unreadable template\nCode: invalid_argument\n');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});

test('a missing template argument is a commander usage error, exit 2', async () => {
  const harness = createHarness({ client: createFakeClient() });
  await harness.run(['describe']);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});
