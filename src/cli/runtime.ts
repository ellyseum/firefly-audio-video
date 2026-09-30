/**
 * The seam every CLI command depends on instead of the real process: a
 * client to skip building one, an environment to read credentials and
 * defaults from, the streams a command's output goes to, and the function
 * that ends the process. {@link createProgram} builds one from real
 * `process` state by default; a test supplies its own.
 */

import type { Client } from '../dgr/client.js';

/** A plain environment map — a subset of `process.env` a test can construct without touching it. */
export type CliEnv = Record<string, string | undefined>;

/** What every command action reads instead of the real process. */
export interface CliRuntime {
  /** Skips building a client from credentials — the shape `createClient()` returns. */
  readonly client: Client | undefined;
  readonly env: CliEnv;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  /** Ends the process with this exit code. Never called more than once per invocation. */
  readonly exit: (code: number) => void;
}

/**
 * The options every command reads via `command.optsWithGlobals()`: the root
 * program's credential, storage and output flags, merged with whatever the
 * invoked subcommand declared for itself.
 */
export interface GlobalOptions {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  storage?: string;
  region?: string;
  log?: boolean;
  json?: boolean;
}
