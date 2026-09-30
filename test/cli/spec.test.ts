import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { AudioVideoError } from '../../src/core/errors.js';
import { buildRenderRequestFromFlags, readSpecFile } from '../../src/cli/spec.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'firefly-audio-video-cli-spec-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rejection(fn: () => unknown): AudioVideoError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AudioVideoError);
    return error as AudioVideoError;
  }
  throw new Error('expected a throw');
}

test('readSpecFile reads and JSON-parses the file, unchanged', () => {
  const path = join(dir, 'spec.json');
  writeFileSync(path, JSON.stringify({ source: 'x', presets: [{ presetId: 'p' }], outputs: [] }));
  expect(readSpecFile(path)).toEqual({ source: 'x', presets: [{ presetId: 'p' }], outputs: [] });
});

test('readSpecFile rejects invalid_argument for a missing file', () => {
  const error = rejection(() => readSpecFile(join(dir, 'does-not-exist.json')));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('does-not-exist.json');
});

test('readSpecFile rejects invalid_argument for invalid JSON', () => {
  const path = join(dir, 'bad.json');
  writeFileSync(path, '{ this is not json');
  const error = rejection(() => readSpecFile(path));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('not valid JSON');
});

test('buildRenderRequestFromFlags builds one output with no destination, from --template and --preset', () => {
  const spec = buildRenderRequestFromFlags({
    template: 'https://example.test/t.mogrt',
    preset: 'prores',
  });
  expect(spec).toEqual({
    source: 'https://example.test/t.mogrt',
    presets: ['prores'],
    outputs: [{ presetIndex: 0 }],
  });
});

test('buildRenderRequestFromFlags builds a preset from --encode JSON', () => {
  const spec = buildRenderRequestFromFlags({
    template: 't.mogrt',
    encode: '{"codec":"hevc","bitDepth":10}',
  });
  expect(spec).toEqual({
    source: 't.mogrt',
    presets: [{ codec: 'hevc', bitDepth: 10 }],
    outputs: [{ presetIndex: 0 }],
  });
});

test('rejects invalid_argument with no --template', () => {
  const error = rejection(() => buildRenderRequestFromFlags({ preset: 'prores' }));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('--template');
});

test('rejects invalid_argument when both --preset and --encode are given', () => {
  const error = rejection(() =>
    buildRenderRequestFromFlags({
      template: 't.mogrt',
      preset: 'prores',
      encode: '{"codec":"hevc"}',
    }),
  );
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('not both');
});

test('rejects invalid_argument when neither --preset nor --encode is given', () => {
  const error = rejection(() => buildRenderRequestFromFlags({ template: 't.mogrt' }));
  expect(error.code).toBe('invalid_argument');
});

test('rejects invalid_argument for --encode that is not valid JSON', () => {
  const error = rejection(() =>
    buildRenderRequestFromFlags({ template: 't.mogrt', encode: 'not json' }),
  );
  expect(error.code).toBe('invalid_argument');
});

test('rejects invalid_argument for --encode that is valid JSON but not an object', () => {
  expect(
    rejection(() => buildRenderRequestFromFlags({ template: 't.mogrt', encode: '[1,2,3]' })).code,
  ).toBe('invalid_argument');
  expect(
    rejection(() => buildRenderRequestFromFlags({ template: 't.mogrt', encode: '"hevc"' })).code,
  ).toBe('invalid_argument');
  expect(
    rejection(() => buildRenderRequestFromFlags({ template: 't.mogrt', encode: 'null' })).code,
  ).toBe('invalid_argument');
});
