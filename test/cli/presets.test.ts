import { expect, test, vi } from 'vitest';
import { AudioVideoError } from '../../src/core/errors.js';
import { PRESET_NAMES } from '../../src/presets/names.js';
import type { PresetSummary } from '../../src/dgr/client.js';
import { createFakeClient } from './support/fake-client.js';
import { createHarness } from './support/harness.js';

test('with no flag, lists the offline typed catalog — no client is ever touched', async () => {
  const listPresets = vi.fn();
  const harness = createHarness({ client: createFakeClient({ listPresets }) });
  await harness.run(['presets']);
  const list = JSON.parse(harness.stdoutText()) as unknown[];
  expect(list).toHaveLength(PRESET_NAMES.length);
  expect(list[0]).toMatchObject({ kind: 'named', name: PRESET_NAMES[0] });
  expect(listPresets).not.toHaveBeenCalled();
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test('works with zero credentials configured, since it never builds a client', async () => {
  const harness = createHarness({ env: {} }); // no client injected, no credentials in env
  await harness.run(['presets']);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(harness.stderrText()).toBe('');
});

test('--json mode lists the offline catalog under the presets field', async () => {
  const harness = createHarness({ client: createFakeClient() });
  await harness.run(['presets', '--json']);
  const body = JSON.parse(harness.stdoutText().trim()) as { ok: boolean; presets: unknown[] };
  expect(body.ok).toBe(true);
  expect(body.presets).toHaveLength(PRESET_NAMES.length);
});

test('--remote lists the native presets from client.listPresets()', async () => {
  const remote: PresetSummary[] = [
    { presetId: 'ffs_video_api_land_1080p_hq', label: 'Landscape HQ' },
  ];
  const client = createFakeClient({ listPresets: vi.fn(async () => remote) });
  const harness = createHarness({ client });
  await harness.run(['presets', '--remote']);
  expect(JSON.parse(harness.stdoutText())).toEqual(remote);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test('--remote --json wraps the native presets under presets, as exactly one document', async () => {
  const remote: PresetSummary[] = [{ presetId: 'ffs_video_api_prores' }];
  const client = createFakeClient({ listPresets: vi.fn(async () => remote) });
  const harness = createHarness({ client });
  await harness.run(['presets', '--remote', '--json']);
  const lines = harness
    .stdoutText()
    .split('\n')
    .filter((line) => line !== '');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? '')).toEqual({ ok: true, presets: remote });
});

test('--remote failure maps to the error family exit code', async () => {
  const failure = new AudioVideoError({ message: 'not authorized', code: 'auth_failed' });
  const client = createFakeClient({ listPresets: vi.fn(async () => Promise.reject(failure)) });
  const harness = createHarness({ client });
  await harness.run(['presets', '--remote']);
  expect(harness.stderrText()).toBe('Error: not authorized\nCode: auth_failed\n');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(3);
});

test('--remote with no credentials configured fails with the missing-credentials message, exit 2', async () => {
  const harness = createHarness({ env: {} });
  await harness.run(['presets', '--remote']);
  expect(harness.stderrText()).toContain('No credentials configured');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});
