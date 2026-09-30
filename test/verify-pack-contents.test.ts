import { expect, test } from 'vitest';
import {
  checkPackedFiles,
  extractTrailingJson,
  resolvePublishEntry,
} from '../scripts/verify-pack-contents.mjs';

const PACKAGE_NAME = 'firefly-audio-video';

const CLEAN_FILES = [
  'LICENSE',
  'README.md',
  'package.json',
  'dist/index.js',
  'dist/index.cjs',
  'dist/index.d.ts',
  'dist/cli.cjs',
];

// --- extractTrailingJson -----------------------------------------------------

test('extractTrailingJson: parses output that is pure JSON', () => {
  expect(extractTrailingJson('{"a":1}')).toEqual({ a: 1 });
});

test('extractTrailingJson: skips lifecycle-script log lines before the JSON', () => {
  const output = [
    '> firefly-audio-video@0.1.0 prepublishOnly',
    '> npm run build',
    '',
    'CLI Building entry: src/cli.ts, src/index.ts',
    '{"name":"firefly-audio-video","files":[{"path":"LICENSE"}]}',
  ].join('\n');
  expect(extractTrailingJson(output)).toEqual({
    name: 'firefly-audio-video',
    files: [{ path: 'LICENSE' }],
  });
});

test('extractTrailingJson: a brace inside a log line does not stop the scan', () => {
  const output = ['a log line with a stray { in it', '{"ok":true}'].join('\n');
  expect(extractTrailingJson(output)).toEqual({ ok: true });
});

test('extractTrailingJson: throws when no JSON is present', () => {
  expect(() => extractTrailingJson('nothing but log lines here')).toThrow(/no parseable JSON/);
});

// --- resolvePublishEntry ------------------------------------------------------

test('resolvePublishEntry: the flat shape (npm 11 locally) resolves', () => {
  const manifest = { id: 'firefly-audio-video@0.1.0', files: [{ path: 'LICENSE' }] };
  const { entry, topLevelKeys } = resolvePublishEntry(manifest, PACKAGE_NAME);
  expect(entry).toBe(manifest);
  expect(topLevelKeys).toEqual(['id', 'files']);
});

test('resolvePublishEntry: the keyed-by-package-name shape (npm bundled with Node 24 in CI) resolves', () => {
  const inner = {
    id: 'firefly-audio-video@0.1.0',
    name: 'firefly-audio-video',
    files: [{ path: 'LICENSE' }],
  };
  const manifest = { [PACKAGE_NAME]: inner };
  const { entry, topLevelKeys } = resolvePublishEntry(manifest, PACKAGE_NAME);
  expect(entry).toBe(inner);
  expect(topLevelKeys).toEqual([PACKAGE_NAME]);
});

test("resolvePublishEntry: npm pack --json's array-of-one shape resolves", () => {
  const inner = { name: 'firefly-audio-video', files: [{ path: 'LICENSE' }] };
  const { entry, topLevelKeys } = resolvePublishEntry([inner], PACKAGE_NAME);
  expect(entry).toBe(inner);
  expect(topLevelKeys).toEqual(['0']);
});

test('resolvePublishEntry: a keyed shape for a different package name fails', () => {
  const manifest = { 'some-other-package': { files: [{ path: 'LICENSE' }] } };
  const { entry, topLevelKeys } = resolvePublishEntry(manifest, PACKAGE_NAME);
  expect(entry).toBeUndefined();
  expect(topLevelKeys).toEqual(['some-other-package']);
});

test('resolvePublishEntry: an unrecognized shape fails, naming the top-level keys it saw', () => {
  const manifest = { warning: 'deprecated', notice: 'see docs' };
  const { entry, topLevelKeys } = resolvePublishEntry(manifest, PACKAGE_NAME);
  expect(entry).toBeUndefined();
  expect(topLevelKeys).toEqual(['warning', 'notice']);
});

test('resolvePublishEntry: null and non-object manifests fail without throwing', () => {
  expect(resolvePublishEntry(null, PACKAGE_NAME)).toEqual({ entry: undefined, topLevelKeys: [] });
  expect(resolvePublishEntry('a string', PACKAGE_NAME)).toEqual({
    entry: undefined,
    topLevelKeys: [],
  });
});

// --- checkPackedFiles ---------------------------------------------------------

test('checkPackedFiles: the real packed contract produces zero violations', () => {
  expect(checkPackedFiles(CLEAN_FILES)).toEqual([]);
});

test('checkPackedFiles: missing LICENSE is reported', () => {
  const violations = checkPackedFiles(CLEAN_FILES.filter((p) => p !== 'LICENSE'));
  expect(violations.some((v) => v.includes('"LICENSE"'))).toBe(true);
});

test('checkPackedFiles: missing README.md is reported', () => {
  const violations = checkPackedFiles(CLEAN_FILES.filter((p) => p !== 'README.md'));
  expect(violations.some((v) => v.includes('"README.md"'))).toBe(true);
});

test('checkPackedFiles: missing package.json is reported', () => {
  const violations = checkPackedFiles(CLEAN_FILES.filter((p) => p !== 'package.json'));
  expect(violations.some((v) => v.includes('"package.json"'))).toBe(true);
});

test('checkPackedFiles: no dist/ entry at all is reported', () => {
  const violations = checkPackedFiles(CLEAN_FILES.filter((p) => !p.startsWith('dist/')));
  expect(violations.some((v) => v.includes('dist/'))).toBe(true);
});

test.each([
  ['test/asset.test.ts', 'test/'],
  ['.claude/settings.json', '.claude/'],
  ['plans/2026-09-29-release.md', 'plans/'],
  ['docs/superpowers/sdd/notes.md', 'docs/superpowers/'],
  ['.superpowers/state.json', '.superpowers/'],
  ['notes/task-15.plan.md', '*.plan.md'],
  ['.scratch/output.txt', 'scratch'],
  ['scratch/output.txt', 'scratch'],
  ['coverage/lcov.info', 'coverage'],
])('checkPackedFiles: a packed "%s" is forbidden (%s)', (leaked) => {
  const violations = checkPackedFiles([...CLEAN_FILES, leaked]);
  expect(violations.some((v) => v.includes(leaked))).toBe(true);
});
