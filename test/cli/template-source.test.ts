import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { resolveTemplateUrl } from '../../src/cli/template-source.js';
import { createFakeClient } from './support/fake-client.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'firefly-audio-video-cli-template-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('an http(s) URL passes through unchanged, without staging', async () => {
  const stage = vi.fn();
  const client = createFakeClient({ stage });
  const url = 'https://example.test/capsule.mogrt?sig=abc';
  await expect(resolveTemplateUrl(client, url)).resolves.toBe(url);
  expect(stage).not.toHaveBeenCalled();
});

test('an existing local file is staged, and the staged URL is returned', async () => {
  const path = join(dir, 'capsule.mogrt');
  writeFileSync(path, 'bytes');
  const stage = vi.fn(async () => 'https://staged.example.test/capsule.mogrt?sig=xyz');
  const client = createFakeClient({ stage });
  await expect(resolveTemplateUrl(client, path)).resolves.toBe(
    'https://staged.example.test/capsule.mogrt?sig=xyz',
  );
  expect(stage).toHaveBeenCalledWith(path);
});

test('a string that is neither an http(s) URL nor an existing file passes through unchanged', async () => {
  const stage = vi.fn();
  const client = createFakeClient({ stage });
  const value = 'not-a-url-and-not-a-file.mogrt';
  await expect(resolveTemplateUrl(client, value)).resolves.toBe(value);
  expect(stage).not.toHaveBeenCalled();
});

test('propagates whatever client.stage() rejects with, for an existing file', async () => {
  const path = join(dir, 'capsule.mogrt');
  writeFileSync(path, 'bytes');
  const failure = new Error('storage not configured');
  const client = createFakeClient({ stage: vi.fn(async () => Promise.reject(failure)) });
  await expect(resolveTemplateUrl(client, path)).rejects.toBe(failure);
});
