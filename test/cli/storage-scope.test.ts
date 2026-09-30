/**
 * Which commands read `--storage` / `DGR_STORAGE`, and what a command
 * prints about a value it rejects: render, stage and describe stage files
 * or allocate outputs through it and so resolve it; status, cancel, presets
 * and encode never touch storage, so a stale or invalid value leaves them
 * working. Each command runs on a real client whose IMS and DGR requests
 * reach a MockAgent, never the network.
 */

import { afterEach, beforeEach, expect, test } from 'vitest';
import { MockApi } from '../support/mock-api.js';
import { createHarness } from './support/harness.js';

const CREDENTIALS = { IMS_OAUTH_S2S_CLIENT_ID: 'id', IMS_OAUTH_S2S_CLIENT_SECRET: 'secret' };
const INVALID = 'gcs://stale-bucket';
const ACCOUNT_KEY = 'U1RPUkFHRV9LRVlfTVVTVF9ORVZFUl9BUFBFQVI=';
const CONNECTION_STRING = `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${ACCOUNT_KEY}`;

let api: MockApi;

beforeEach(() => {
  api = new MockApi();
  api.ims();
  api.reply('GET', '/v1/status/job-1', 200, { jobId: 'job-1', status: 'succeeded' });
  api.cancel('job-1');
  api.reply('GET', '/v1/presets', 200, { items: [{ presetId: 'ffs_video_api_prores' }] });
});

afterEach(async () => {
  await api.close();
});

const IGNORING: Array<[name: string, args: string[]]> = [
  ['status', ['status', 'job-1']],
  ['cancel', ['cancel', 'job-1']],
  ['presets --remote', ['presets', '--remote']],
  ['presets', ['presets']],
  ['encode', ['encode', '{"codec":"hevc"}']],
];

test.each(IGNORING)('an invalid DGR_STORAGE never stops %s', async (_name, args) => {
  const harness = createHarness({ env: { ...CREDENTIALS, DGR_STORAGE: INVALID } });
  await harness.run(args);
  expect(harness.stderrText()).toBe('');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test.each(IGNORING)('an invalid --storage never stops %s', async (_name, args) => {
  const harness = createHarness({ env: CREDENTIALS });
  await harness.run([...args, '--storage', INVALID]);
  expect(harness.stderrText()).toBe('');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test.each<[name: string, args: string[]]>([
  ['render', ['render', '--template', 'https://example.test/t.mogrt', '--preset', 'prores']],
  ['stage', ['stage', 'https://example.test/logo.png']],
  ['describe', ['describe', 'https://example.test/t.mogrt']],
])(
  '%s resolves storage, so an invalid DGR_STORAGE fails it with exit 2 before any request',
  async (_name, args) => {
    const harness = createHarness({ env: { ...CREDENTIALS, DGR_STORAGE: INVALID } });
    await harness.run(args);
    expect(harness.stderrText()).toContain('Code: invalid_argument');
    expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
    expect(api.calls).toEqual([]);
  },
);

test.each<[source: string, env: Record<string, string>, flags: string[]]>([
  ['DGR_STORAGE', { DGR_STORAGE: CONNECTION_STRING }, []],
  ['--storage', {}, ['--storage', CONNECTION_STRING]],
])(
  'a connection string given as %s is rejected by name and scheme, and never printed',
  async (source, env, flags) => {
    for (const mode of [[], ['--json']]) {
      const harness = createHarness({ env: { ...CREDENTIALS, ...env } });
      await harness.run(['stage', 'https://example.test/logo.png', ...flags, ...mode]);
      const printed = harness.stdoutText() + harness.stderrText();
      expect(printed).toContain(`${source} must be`);
      expect(printed).toContain('the value given has no scheme');
      expect(printed).not.toContain(ACCOUNT_KEY);
      expect(printed).not.toContain('AccountKey');
      expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
    }
  },
);
