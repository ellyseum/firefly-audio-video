import { expect, test, vi } from 'vitest';
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

const USAGE_ERRORS: Array<[kind: string, args: string[], text: string]> = [
  [
    'an unknown option',
    ['stage', 'x', '--this-flag-does-not-exist'],
    "unknown option '--this-flag-does-not-exist'",
  ],
  ['an unknown command', ['bogus-command'], "unknown command 'bogus-command'"],
  ['a missing positional', ['stage'], "missing required argument 'file'"],
];

function stdoutLines(text: string): string[] {
  return text.split('\n').filter((line) => line !== '');
}

test.each(USAGE_ERRORS)(
  "%s in human mode prints commander's text on stderr and nothing on stdout, exiting 2",
  async (_kind, args, text) => {
    const harness = createHarness({ client: createFakeClient() });
    await harness.run(args);
    expect(harness.stdoutText()).toBe('');
    expect(harness.stderrText()).toContain(`error: ${text}`);
    expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
  },
);

test.each(USAGE_ERRORS)(
  '%s with --json prints exactly one invalid_argument document on stdout and nothing on stderr, exiting 2',
  async (_kind, args, text) => {
    const harness = createHarness({ client: createFakeClient() });
    await harness.run(['--json', ...args]);
    const lines = stdoutLines(harness.stdoutText());
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      ok: false,
      error: { code: 'invalid_argument', message: expect.stringContaining(text) },
    });
    expect(harness.stderrText()).toBe('');
    expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
  },
);

const TYPED_VALUE = 'TYPED_VALUE_MUST_NEVER_PRINT';

test.each<[form: string, args: string[], named: string]>([
  [
    '--name=value on a subcommand',
    ['stage', 'x', `--client-secrt=${TYPED_VALUE}`],
    '--client-secrt',
  ],
  ['--name=value before the command', [`--bogus=${TYPED_VALUE}`, 'status', 'job-1'], '--bogus'],
  ['-xvalue', ['stage', 'x', `-z${TYPED_VALUE}`], '-z'],
])(
  'an unknown option written as %s is named without its value, in human and --json output',
  async (_form, args, named) => {
    const human = createHarness({ client: createFakeClient() });
    await human.run(args);
    expect(human.stderrText()).toContain(`error: unknown option '${named}'`);
    expect(human.stdoutText() + human.stderrText()).not.toContain(TYPED_VALUE);
    expect(human.exit).toHaveBeenCalledExactlyOnceWith(2);

    const json = createHarness({ client: createFakeClient() });
    await json.run([...args, '--json']);
    const lines = stdoutLines(json.stdoutText());
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      ok: false,
      error: { code: 'invalid_argument', message: expect.stringContaining(`'${named}'`) },
    });
    expect(json.stdoutText() + json.stderrText()).not.toContain(TYPED_VALUE);
    expect(json.exit).toHaveBeenCalledExactlyOnceWith(2);
  },
);

test('an unknown option is matched against the real options by its name alone', async () => {
  const harness = createHarness({ client: createFakeClient() });
  await harness.run(['stage', 'x', `--client-secrt=${TYPED_VALUE}`]);
  expect(harness.stderrText()).toContain('(Did you mean --client-secret?)');
});

const CLOUD_SECRET = 'CLOUD_SECRET_VALUE_MUST_NEVER_PRINT';

test.each<[flag: string]>([['--aws-secret-access-key'], ['--azure-storage-connection-string']])(
  '%s is refused as a flag, exit 2 before any render, and its value is never printed',
  async (flag) => {
    for (const given of [[flag, CLOUD_SECRET], [`${flag}=${CLOUD_SECRET}`]]) {
      for (const mode of [[], ['--json']]) {
        const render = vi.fn();
        const harness = createHarness({ client: createFakeClient({ render }) });
        await harness.run([
          'render',
          '--template',
          't.mogrt',
          '--preset',
          'prores',
          ...given,
          ...mode,
        ]);
        const printed = harness.stdoutText() + harness.stderrText();
        expect(printed).toContain(`unknown option '${flag}'`);
        expect(printed).not.toContain(CLOUD_SECRET);
        expect(render).not.toHaveBeenCalled();
        expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
      }
    }
  },
);

test('a usage error honors --json given after the subcommand, and not a --json that follows --', async () => {
  const after = createHarness({ client: createFakeClient() });
  await after.run(['stage', 'x', '--bogus', '--json']);
  expect(stdoutLines(after.stdoutText())).toHaveLength(1);
  expect(after.stderrText()).toBe('');

  const positional = createHarness({ client: createFakeClient() });
  await positional.run(['bogus-command', '--', '--json']);
  expect(positional.stdoutText()).toBe('');
  expect(positional.stderrText()).toContain("error: unknown command 'bogus-command'");
  expect(positional.exit).toHaveBeenCalledExactlyOnceWith(2);
});

test('a global option is read the same way whether given before or after the subcommand name', async () => {
  const remote = [{ presetId: 'p' }];
  const before = createHarness({ client: createFakeClient({ listPresets: async () => remote }) });
  await before.run(['--json', 'presets', '--remote']);
  const after = createHarness({ client: createFakeClient({ listPresets: async () => remote }) });
  await after.run(['presets', '--remote', '--json']);
  expect(before.stdoutText()).toBe(after.stdoutText());
});

test('by default an exit sets process.exitCode and never calls process.exit', async () => {
  const original = process.exitCode;
  const processExit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${String(code)}) was called`);
  });
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  try {
    await createProgram({ env: {}, stdout: sink, stderr: sink }).parseAsync(['bogus-command'], {
      from: 'user',
    });
    expect(process.exitCode).toBe(2);
    expect(processExit).not.toHaveBeenCalled();
  } finally {
    process.exitCode = original;
    processExit.mockRestore();
  }
});

test('createProgram() builds without any options, defaulting to the real process streams', () => {
  // Constructing the program touches nothing beyond configuration — parseAsync()
  // is never called here, so the real process.exit is never at risk.
  const program = createProgram();
  expect(program.name()).toBe('dgr');
});
