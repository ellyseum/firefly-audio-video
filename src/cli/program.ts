/**
 * Builds the `dgr` commander program: a pure factory over a
 * {@link CliRuntime} (the real process by default, or a test's fakes),
 * wired so every exit — a command's own, or commander's own usage errors —
 * goes through `runtime.exit()`, which by default sets `process.exitCode`
 * and lets the process end once its event loop drains. With `--json` in
 * argv, a usage error prints the same one-document failure every command
 * prints, on stdout, instead of commander's own text on stderr.
 */

import { Command, CommanderError } from 'commander';
import { redactValue } from '../core/redact.js';
import { VERSION } from '../index.js';
import type { Client } from '../dgr/client.js';
import { buildCancelCommand } from './commands/cancel.js';
import { buildDescribeCommand } from './commands/describe.js';
import { buildEncodeCommand } from './commands/encode.js';
import { buildPresetsCommand } from './commands/presets.js';
import { buildRenderCommand } from './commands/render.js';
import { buildStageCommand } from './commands/stage.js';
import { buildStatusCommand } from './commands/status.js';
import { invalidArgument } from './errors.js';
import { exitCodesHelpText } from './exit-codes.js';
import { printFailure } from './output.js';
import type { CliEnv, CliRuntime, InterruptSource } from './runtime.js';

/** Whether the argv being parsed asks for `--json`; set at the start of every parse. */
interface ParseState {
  json: boolean;
}

/** Everything {@link createProgram} can be given instead of the real process. */
export interface CreateProgramOptions {
  /** Skips building a client from credentials — the shape `createClient()` returns. */
  client?: Client;
  env?: CliEnv;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /**
   * Sets the exit code. Called exactly once per invocation. Defaults to
   * setting `process.exitCode`, so the process ends once pending work has
   * drained.
   */
  exit?: (code: number) => void;
  /** Ends the process at once; only a second Ctrl+C during `render` calls it. Defaults to `process.exit`. */
  forceExit?: (code: number) => void;
  /** Subscribes to Ctrl+C for as long as `render` runs. Defaults to the process's `SIGINT`. */
  onInterrupt?: InterruptSource;
}

const EPILOG = [
  '',
  'Credentials come from IMS_OAUTH_S2S_CLIENT_ID / IMS_OAUTH_S2S_CLIENT_SECRET (and optionally',
  'IMS_OAUTH_S2S_SCOPES) in the environment, or --client-id / --client-secret / --scope.',
  'The environment is preferred: a command-line value is visible to other processes on this machine.',
  '',
  exitCodesHelpText(),
].join('\n');

/**
 * A configured `dgr` program. `options.client` makes every command run on
 * that client, skipping credential resolution entirely — how a test drives
 * this with no network. `parseAsync()` on the returned program never
 * rejects: every exit path, commander's own included, calls `options.exit`
 * exactly once, and only a second Ctrl+C during `render` calls
 * `options.forceExit`.
 */
export function createProgram(options: CreateProgramOptions = {}): Command {
  const runtime: CliRuntime = {
    client: options.client,
    env: options.env ?? process.env,
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    exit: options.exit ?? setProcessExitCode,
    forceExit: options.forceExit ?? ((code: number) => process.exit(code)),
    onInterrupt: options.onInterrupt ?? onProcessSigint,
  };

  const parse: ParseState = { json: false };
  const outputConfiguration = {
    writeOut: (text: string) => {
      runtime.stdout.write(text);
    },
    writeErr: (text: string) => {
      runtime.stderr.write(text);
    },
    // Commander's usage-error text, redacted: with --json the JSON document takes its place.
    outputError: (text: string, write: (text: string) => void) => {
      if (!parse.json) write(redactValue(text));
    },
  };

  const program = new Command('dgr');
  program
    .description('Adobe Firefly Services audio/video (DGR) CLI.')
    .version(VERSION, '-V, --version', 'outputs the package version')
    .configureOutput(outputConfiguration)
    .exitOverride()
    .option('--client-id <id>', 'the integration client ID (or IMS_OAUTH_S2S_CLIENT_ID)')
    .option(
      '--client-secret <secret>',
      'the integration client secret (or IMS_OAUTH_S2S_CLIENT_SECRET) — prefer the environment, ' +
        'since a value here is visible to other processes on this machine',
    )
    .option('--scope <scope>', 'IMS scopes, comma-separated (or IMS_OAUTH_S2S_SCOPES)')
    .option(
      '--storage <uri>',
      "where local files and generated outputs are staged: 's3://<bucket>[/<prefix>]', " +
        "'azure://<container>[/<prefix>]', or 'aio-files' (or DGR_STORAGE)",
    )
    .option(
      '--region <region>',
      "s3:// storage's bucket region (or AWS_REGION / AWS_DEFAULT_REGION)",
    )
    .option('--log', 'writes one NDJSON record per SDK call to stderr — off by default')
    .option('--json', 'prints one JSON document instead of human-readable text')
    .addHelpText('after', EPILOG);

  program.addCommand(buildRenderCommand(runtime));
  program.addCommand(buildDescribeCommand(runtime));
  program.addCommand(buildPresetsCommand(runtime));
  program.addCommand(buildStatusCommand(runtime));
  program.addCommand(buildCancelCommand(runtime));
  program.addCommand(buildStageCommand(runtime));
  program.addCommand(buildEncodeCommand(runtime));

  // `.addCommand()` does not inherit the parent's output, exit and help
  // configuration the way `.command()` does, so every command — root
  // included — is configured explicitly here, once, regardless of how it was
  // attached. Each subcommand's help lists the global options too.
  for (const command of [program, ...program.commands]) {
    command.configureOutput(outputConfiguration);
    command.exitOverride();
    command.configureHelp({ showGlobalOptions: true });
    reportOptionNamesOnly(command);
  }

  wrapParseAsync(program, runtime, parse);
  return program;
}

/**
 * Makes `command` name an unknown option without whatever was written after
 * its name — `--name=value` reports as `--name`, `-xvalue` as `-x` — so a
 * mistyped option never prints the value typed with it, in either output
 * mode. Commander hands the whole token to its `unknownOption()`, which
 * builds that error's message and its "Did you mean" suggestion.
 */
function reportOptionNamesOnly(command: Command): void {
  const reporter = command as unknown as { unknownOption(flag: string): void };
  const report = reporter.unknownOption.bind(command);
  reporter.unknownOption = (flag) => report(optionName(flag));
}

/** The option a command-line token names: a long option up to any `=`, a short one's first letter. */
function optionName(token: string): string {
  if (token.startsWith('--')) {
    const equals = token.indexOf('=');
    return equals === -1 ? token : token.slice(0, equals);
  }
  return token.slice(0, 2);
}

/**
 * Sets the process's exit code, leaving the process to end once its event
 * loop drains. `process.exit()` while a fetch's handles are still closing
 * aborts Node on Windows (libuv's `UV_HANDLE_CLOSING` assertion) and
 * replaces the exit code with 0xC0000409.
 */
function setProcessExitCode(code: number): void {
  process.exitCode = code;
}

/** Subscribes `listener` to the process's `SIGINT`; the returned function unsubscribes it. */
function onProcessSigint(listener: () => void): () => void {
  process.on('SIGINT', listener);
  return () => {
    process.removeListener('SIGINT', listener);
  };
}

/**
 * Replaces `program.parseAsync` with a version that never rejects and never
 * lets commander's `exitOverride` throw escape: a `CommanderError` (usage
 * errors, `--help`, `--version`) maps to its own exit code; anything else —
 * which no command action should let through, since each catches its own
 * errors — prints as any command's failure does, redacted, and exits `1`.
 * A usage error under `--json` also prints
 * `{ ok: false, error: { code: 'invalid_argument', message } }` on stdout.
 */
function wrapParseAsync(program: Command, runtime: CliRuntime, parse: ParseState): void {
  const original = program.parseAsync.bind(program);
  const wrapped: typeof program.parseAsync = async (...args) => {
    parse.json = wantsJson(args[0] ?? process.argv);
    try {
      await original(...args);
    } catch (error) {
      if (error instanceof CommanderError) {
        const code = commanderExitCode(error);
        if (code === 2 && parse.json) {
          printFailure(runtime, true, invalidArgument(usageMessage(error, program)));
        }
        runtime.exit(code);
      } else {
        printFailure(runtime, parse.json, error);
        runtime.exit(1);
      }
    }
    return program;
  };
  program.parseAsync = wrapped;
}

/**
 * Help or the version, asked for, exits `0`; every other commander usage
 * error exits `2` — `dgr` with no command included, which commander answers
 * with help on stderr and a non-zero code of its own.
 */
function commanderExitCode(error: CommanderError): number {
  const shown = new Set(['commander.version', 'commander.help', 'commander.helpDisplayed']);
  return shown.has(error.code) && error.exitCode === 0 ? 0 : 2;
}

/** True when `argv` passes `--json` ahead of any `--`, after which every token is a positional. */
function wantsJson(argv: readonly string[]): boolean {
  const end = argv.indexOf('--');
  return (end === -1 ? argv : argv.slice(0, end)).includes('--json');
}

/**
 * The failure document's message for a usage error: commander's text without
 * its `error: ` prefix, which the document already says — or, for `dgr` with
 * no command, whose help commander prints instead of a message, the commands
 * to choose from.
 */
function usageMessage(error: CommanderError, program: Command): string {
  if (error.code === 'commander.help') {
    const names = program.commands.map((command) => command.name());
    return `dgr needs a command: ${names.slice(0, -1).join(', ')} or ${names.at(-1) ?? ''}.`;
  }
  return error.message.replace(/^error: /, '').trim();
}
