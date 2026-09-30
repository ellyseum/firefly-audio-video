import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { HEVC_BASE_EPR } from '../../src/presets/epr-templates/hevc.js';
import { createHarness } from './support/harness.js';

/** The pair of numbers baked into the HEVC system-preset template — the family's own identity. */
const HEVC_CLASS_ID = /<ExporterClassID>(\d+)<\/ExporterClassID>/.exec(HEVC_BASE_EPR)?.[1];
const HEVC_FILE_TYPE = /<ExporterFileType>(\d+)<\/ExporterFileType>/.exec(HEVC_BASE_EPR)?.[1];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'firefly-audio-video-cli-encode-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('never builds a client — no credentials configured, no injected client', async () => {
  const harness = createHarness({ env: {} });
  await harness.run(['encode', '{"codec":"hevc"}']);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test('human mode prints the raw .epr XML, carrying the HEVC family identity', async () => {
  const harness = createHarness({ env: {} });
  await harness.run(['encode', '{"codec":"hevc","resolution":"1920x1080"}']);
  const xml = harness.stdoutText();
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  expect(xml).toContain(`<ExporterClassID>${HEVC_CLASS_ID}</ExporterClassID>`);
  expect(xml).toContain(`<ExporterFileType>${HEVC_FILE_TYPE}</ExporterFileType>`);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test('--json mode prints exactly one document with the xml field', async () => {
  const harness = createHarness({ env: {} });
  await harness.run(['encode', '{"codec":"hevc"}', '--json']);
  const lines = harness
    .stdoutText()
    .split('\n')
    .filter((line) => line !== '');
  expect(lines).toHaveLength(1);
  const body = JSON.parse(lines[0] ?? '') as { ok: boolean; xml: string };
  expect(body.ok).toBe(true);
  expect(body.xml).toContain('<PremiereData');
});

test('--out writes the XML to disk and prints the path instead of the XML', async () => {
  const path = join(dir, 'preset.epr');
  const harness = createHarness({ env: {} });
  await harness.run(['encode', '{"codec":"hevc"}', '--out', path]);
  expect(harness.stdoutText()).toBe(`${path}\n`);
  const written = readFileSync(path, 'utf8');
  expect(written).toContain('<PremiereData');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test('--out --json reports the path under path, not the XML body', async () => {
  const path = join(dir, 'preset.epr');
  const harness = createHarness({ env: {} });
  await harness.run(['encode', '{"codec":"hevc"}', '--out', path, '--json']);
  expect(JSON.parse(harness.stdoutText().trim())).toEqual({ ok: true, path });
});

test('invalid JSON rejects invalid_argument, exit 2', async () => {
  const harness = createHarness({ env: {} });
  await harness.run(['encode', 'not json']);
  expect(harness.stderrText()).toContain('Code: invalid_argument');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});

test('a config a codec cannot produce rejects invalid_preset, exit 2', async () => {
  // H.264 renders only through DGR's native presets; toEpr() refuses to generate an .epr for it.
  const harness = createHarness({ env: {} });
  await harness.run(['encode', '{"codec":"h264","bitrate":1000000}']);
  expect(harness.stderrText()).toContain('Code: invalid_preset');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});

test('a missing json argument is a commander usage error, exit 2', async () => {
  const harness = createHarness({ env: {} });
  await harness.run(['encode']);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});
