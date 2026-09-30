/**
 * The advice a CLI user reads is the CLI's own: an error about missing
 * storage names `--storage` / `DGR_STORAGE` and the URI forms, never an SDK
 * option; a missing peer dependency names only its install command; and a
 * peer that fails to load names the command that reinstalls it.
 * The unit cases restate errors built by the SDK's own message builders;
 * the command cases run a real client with no storage configured, whose
 * IMS and DGR requests would reach a MockAgent, never the network.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { cliMessage } from '../../src/cli/advice.js';
import { AudioVideoError } from '../../src/core/errors.js';
import { noStorage } from '../../src/core/storage.js';
import { loadPeer } from '../../src/storage/peer.js';
import { MockApi } from '../support/mock-api.js';
import { createHarness } from './support/harness.js';

const CLI_ADVICE = '--storage <uri> or set DGR_STORAGE';
const URI_FORMS = "('s3://<bucket>[/<prefix>]', 'azure://<container>[/<prefix>]' or 'aio-files')";
const CREDENTIALS = { IMS_OAUTH_S2S_CLIENT_ID: 'id', IMS_OAUTH_S2S_CLIENT_SECRET: 'secret' };

let dir: string;
let api: MockApi;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'firefly-audio-video-cli-advice-'));
  api = new MockApi();
  api.ims();
});

afterEach(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

function expectCliStorageAdvice(text: string): void {
  expect(text).toContain(CLI_ADVICE);
  expect(text).toContain(URI_FORMS);
  expect(text).not.toContain('StorageProvider');
  expect(text).not.toContain('createClient()');
}

test("the SDK's no-storage error names --storage and DGR_STORAGE instead of an SDK option", () => {
  expectCliStorageAdvice(cliMessage(noStorage('The input')));
});

test("a missing peer dependency's message names only the install command", async () => {
  const notFound = Object.assign(new Error("Cannot find package '@aws-sdk/client-s3'"), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
  const peer = {
    specifier: '@aws-sdk/client-s3',
    provider: 'S3StorageProvider',
    install: 'npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner',
    option: 's3',
  };
  const error = await loadPeer(peer, () => Promise.reject(notFound)).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(AudioVideoError);
  const message = cliMessage(error as AudioVideoError);
  expect(message).toContain(
    'install it with `npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`.',
  );
  expect(message).not.toContain('option');
  expect(message).not.toContain('bundled code');
});

test("a storage peer that fails to load keeps its loader's error, redacted, and names the command that reinstalls it", async () => {
  const broken = new SyntaxError(
    'Unexpected token in https://acct.blob.core.windows.net/c/index.js?sv=2024&sig=LOADER_SIG',
  );
  const peer = {
    specifier: '@aws-sdk/client-s3',
    provider: 'S3StorageProvider',
    install: 'npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner',
    option: 's3',
  };
  const error = await loadPeer(peer, () => Promise.reject(broken)).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(AudioVideoError);
  expect((error as AudioVideoError).code).toBe('storage_failed');
  expect(cliMessage(error as AudioVideoError)).toBe(
    'Loading @aws-sdk/client-s3 for S3StorageProvider failed (SyntaxError: Unexpected token in ' +
      'https://acct.blob.core.windows.net/c/index.js): reinstall it with ' +
      '`npm install @aws-sdk/client-s3`.',
  );
});

test('any other error message is left as it is', () => {
  const error = new AudioVideoError({ message: 'The job failed.', code: 'job_failed' });
  expect(cliMessage(error)).toBe('The job failed.');
});

test.each<[name: string, args: (file: string) => string[]]>([
  ['stage of a local file', (file) => ['stage', file]],
  ['describe of a local file', (file) => ['describe', file]],
  [
    'render of a URL template to a native preset',
    () => [
      'render',
      '--template',
      'https://example.test/t.mogrt',
      '--preset',
      'ffs_video_api_prores',
    ],
  ],
  [
    'render of a URL template to an --encode preset',
    () => ['render', '--template', 'https://example.test/t.mogrt', '--encode', '{"codec":"hevc"}'],
  ],
  [
    'render of a local template',
    (file) => ['render', '--template', file, '--preset', 'ffs_video_api_prores'],
  ],
])('%s with no storage configured names --storage and DGR_STORAGE, exit 2', async (_name, args) => {
  const file = join(dir, 'template.mogrt');
  writeFileSync(file, 'bytes');
  for (const mode of [[], ['--json']]) {
    const harness = createHarness({ env: CREDENTIALS });
    await harness.run([...args(file), ...mode]);
    expectCliStorageAdvice(harness.stdoutText() + harness.stderrText());
    expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
  }
});
