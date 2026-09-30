import { expect, test } from 'vitest';
import { VERSION } from '../../src/index.js';
import { createProgram } from '../../src/cli/program.js';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import { createFakeClient } from './support/fake-client.js';
import { createHarness } from './support/harness.js';

test('--version prints exactly the package VERSION to stdout and exits 0', async () => {
  const harness = createHarness();
  await harness.run(['--version']);
  expect(harness.stdoutText()).toBe(`${VERSION}\n`);
  expect(harness.stderrText()).toBe('');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test('-V is the same as --version', async () => {
  const harness = createHarness();
  await harness.run(['-V']);
  expect(harness.stdoutText()).toBe(`${VERSION}\n`);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test('--help prints usage to stdout, including every command and the exit-code table, and exits 0', async () => {
  const harness = createHarness();
  await harness.run(['--help']);
  const text = harness.stdoutText();
  expect(text).toContain('Usage: dgr');
  for (const name of ['render', 'describe', 'presets', 'status', 'cancel', 'stage', 'encode']) {
    expect(text).toContain(name);
  }
  expect(text).toContain('Exit codes:');
  for (const entry of EXIT_CODES) expect(text).toContain(String(entry.code));
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test('--help never mentions passing a secret on the command line as the preferred path', async () => {
  const harness = createHarness();
  await harness.run(['--help']);
  const collapsed = harness.stdoutText().replace(/\s+/g, ' ');
  expect(collapsed).toContain('prefer the environment');
});

test('an unknown command is a commander usage error mapped to exit 2, with no real process.exit', async () => {
  const harness = createHarness();
  await harness.run(['bogus-command']);
  expect(harness.stderrText()).toContain('unknown command');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});

test('an unknown option on a subcommand is a commander usage error mapped to exit 2', async () => {
  const harness = createHarness({ client: createFakeClient() });
  await harness.run(['stage', 'x', '--this-flag-does-not-exist']);
  expect(harness.stderrText()).toContain('unknown option');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});

test('a global option is read the same way whether given before or after the subcommand name', async () => {
  const remote = [{ presetId: 'p' }];
  const before = createHarness({ client: createFakeClient({ listPresets: async () => remote }) });
  await before.run(['--json', 'presets', '--remote']);
  const after = createHarness({ client: createFakeClient({ listPresets: async () => remote }) });
  await after.run(['presets', '--remote', '--json']);
  expect(before.stdoutText()).toBe(after.stdoutText());
});

test('createProgram() builds without any options, defaulting to the real process streams', () => {
  // Constructing the program touches nothing beyond configuration — parseAsync()
  // is never called here, so the real process.exit is never at risk.
  const program = createProgram();
  expect(program.name()).toBe('dgr');
});
