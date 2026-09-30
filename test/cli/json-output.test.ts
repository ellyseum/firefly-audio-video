/**
 * `--json`'s stdout contract holds even when a real client's own SDK
 * logging is on: the log record — one NDJSON line per settled call — goes
 * to stderr, never stdout, so `--json`'s stdout is always exactly one
 * document. Uses a real client (no injected fake) so the SDK's own logging
 * actually runs; the call itself fails locally (no storage configured), so
 * nothing here touches the network.
 */

import { expect, test, vi } from 'vitest';
import { createHarness } from './support/harness.js';

function jsonLines(text: string): string[] {
  return text.split('\n').filter((line) => line !== '');
}

test('--json stdout is exactly one document with --log off (the default)', async () => {
  const harness = createHarness({
    env: { IMS_OAUTH_S2S_CLIENT_ID: 'id', IMS_OAUTH_S2S_CLIENT_SECRET: 's' },
  });
  await harness.run(['stage', 'not-a-url-and-not-a-file', '--json']);
  const lines = jsonLines(harness.stdoutText());
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? '')).toMatchObject({ ok: false });
  expect(harness.stderrText()).toBe('');
});

test('without --log, a real client writes nothing to the process stdout', async () => {
  // The SDK's default logger writes to the process's own stdout, not the
  // runtime's stream, so only a spy on the real stream sees it.
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const harness = createHarness({
      env: { IMS_OAUTH_S2S_CLIENT_ID: 'id', IMS_OAUTH_S2S_CLIENT_SECRET: 's' },
    });
    await harness.run(['stage', 'not-a-url-and-not-a-file', '--json']);
    expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
    expect(write).not.toHaveBeenCalled();
  } finally {
    write.mockRestore();
  }
});

test('--json stdout is exactly one document with --log on — the SDK log line lands on stderr', async () => {
  const harness = createHarness({
    env: { IMS_OAUTH_S2S_CLIENT_ID: 'id', IMS_OAUTH_S2S_CLIENT_SECRET: 's' },
  });
  await harness.run(['stage', 'not-a-url-and-not-a-file', '--json', '--log']);
  const stdoutLines = jsonLines(harness.stdoutText());
  expect(stdoutLines).toHaveLength(1);
  expect(JSON.parse(stdoutLines[0] ?? '')).toMatchObject({ ok: false });
  // The SDK's own NDJSON record landed on stderr, proving --log did fire —
  // this is not a no-op flag, its output is simply routed off stdout.
  const stderrLines = jsonLines(harness.stderrText());
  expect(stderrLines).toHaveLength(1);
  expect(JSON.parse(stderrLines[0] ?? '')).toMatchObject({ level: 'error', msg: 'stage failed' });
});

test('human mode stays readable with --log on: the SDK log line and the error line both land on stderr', async () => {
  const harness = createHarness({
    env: { IMS_OAUTH_S2S_CLIENT_ID: 'id', IMS_OAUTH_S2S_CLIENT_SECRET: 's' },
  });
  await harness.run(['stage', 'not-a-url-and-not-a-file', '--log']);
  expect(harness.stdoutText()).toBe('');
  expect(harness.stderrText()).toContain('Code: invalid_argument');
});
