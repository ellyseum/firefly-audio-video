import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { VERSION } from '../src/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A file under the repository root, as text. */
function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

test('exports a semver VERSION', () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
});

test('VERSION is the version package.json declares, the version the package is published as', () => {
  expect(VERSION).toBe((JSON.parse(read('package.json')) as { version: string }).version);
});

test("release-please rewrites src/version.ts as a generic extra-file, whose VERSION line carries the updater's marker", () => {
  const config = JSON.parse(read('release-please-config.json')) as {
    packages: Record<string, { 'extra-files'?: unknown[] }>;
  };
  expect(config.packages['.']?.['extra-files']).toContainEqual({
    type: 'generic',
    path: 'src/version.ts',
  });
  expect(read('src/version.ts')).toContain(
    `export const VERSION = '${VERSION}'; // x-release-please-version`,
  );
});
