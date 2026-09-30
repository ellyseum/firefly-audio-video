/**
 * `dgr render`: renders a template from `--spec <file>` or from
 * `--template`/`--preset`/`--encode`, and resolves the one output as a URL
 * (the default) or a local file. The first Ctrl+C cancels the job and, once
 * the job rejects, waits up to ten seconds for the cancel request to reach
 * the service before exiting 130; a second Ctrl+C ends the process at once.
 */

import { Command } from 'commander';
import { AudioVideoError } from '../../core/errors.js';
import type { RenderRequest } from '../../dgr/schemas.js';
import { resolveClient } from '../client.js';
import { invalidArgument } from '../errors.js';
import { exitCodeForError } from '../exit-codes.js';
import { printFailure, printSuccess } from '../output.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';
import { buildRenderRequestFromFlags, readSpecFile, type RenderFlags } from '../spec.js';

/** `render`'s own options, exactly as commander reports them. */
interface RenderOwnOptions extends RenderFlags {
  spec?: string;
  out?: string;
  resolveAs?: string;
}

type OutputMode =
  { readonly resolveAs: 'url' } | { readonly resolveAs: 'file'; readonly savePath: string };

/** How long a cancelled render waits for its cancel request to settle before exiting anyway. */
const CANCEL_REQUEST_WAIT_MS = 10_000;

export function buildRenderCommand(runtime: CliRuntime): Command {
  const command = new Command('render');
  command
    .description('Renders a template and resolves with the finished output.')
    .option('--spec <file>', 'a render spec as JSON: { source, presets, outputs }')
    .option('--template <urlOrPath>', 'the template to render — an http(s) URL or a local file')
    .option('--preset <nameOrIdOrPath>', 'a catalog name, a native presetId, or an .epr file path')
    .option('--encode <json>', 'a full encode config as JSON, e.g. \'{"codec":"hevc"}\'')
    .option('--out <path>', 'saves the rendered output to this local path')
    .option(
      '--resolve-as <mode>',
      "how to resolve the output: 'url' (default) or 'file' (needs --out)",
    )
    .action(async (ownOptions: RenderOwnOptions, self: Command) => {
      await runRender(runtime, self.optsWithGlobals() as GlobalOptions & RenderOwnOptions);
    });
  return command;
}

async function runRender(
  runtime: CliRuntime,
  options: GlobalOptions & RenderOwnOptions,
): Promise<void> {
  const json = options.json === true;
  let exited = false;
  const doExit = (code: number): void => {
    if (exited) return;
    exited = true;
    runtime.exit(code);
  };

  let interrupted = false;
  // Settles once the cancel request has been sent — after the submit, when one is still in flight.
  let cancelRequest: Promise<void> = Promise.resolve();
  let stopListening = (): void => undefined;
  try {
    const spec = buildSpec(options);
    const mode = resolveOutputMode(options);
    const client = resolveClient(runtime, options, { storage: true });
    const job =
      mode.resolveAs === 'file'
        ? client.render(spec, { resolveAs: 'file', savePath: mode.savePath })
        : client.render(spec, { resolveAs: 'url' });
    stopListening = runtime.onInterrupt(() => {
      if (!interrupted) {
        interrupted = true;
        runtime.stderr.write('Cancelling the render...\n');
        cancelRequest = job.cancel();
      } else if (!exited) {
        exited = true;
        runtime.forceExit(130);
      }
    });
    const output = await job;
    printSuccess(runtime, json, output, {
      jobId: job.jobId,
      output,
      queueMs: job.meta?.queueMs,
      renderMs: job.meta?.renderMs,
      totalMs: job.meta?.totalMs,
    });
    doExit(0);
  } catch (error) {
    const cancelledByUser =
      interrupted && error instanceof AudioVideoError && error.code === 'cancelled';
    printFailure(runtime, json, error);
    if (interrupted) await settledWithin(cancelRequest, CANCEL_REQUEST_WAIT_MS);
    doExit(exitCodeForError(error, { cancelledByUser }));
  } finally {
    stopListening();
  }
}

/** Resolves once `promise` settles or `ms` pass, whichever comes first; never rejects. */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([promise.then(ignore, ignore), elapsed]);
  } finally {
    clearTimeout(timer);
  }
}

function ignore(): void {}

/** The spec `client.render()` validates: `--spec`'s file, or the flags assembled into one. */
function buildSpec(options: RenderOwnOptions): RenderRequest {
  if (options.spec !== undefined) {
    if (
      options.template !== undefined ||
      options.preset !== undefined ||
      options.encode !== undefined
    ) {
      throw invalidArgument(
        'render takes --spec on its own, not combined with --template, --preset or --encode.',
      );
    }
    return readSpecFile(options.spec) as RenderRequest;
  }
  return buildRenderRequestFromFlags(options) as RenderRequest;
}

/** `--out`/`--resolve-as` reduced to one mode: `--resolve-as file` needs `--out`; neither given prints the URL. */
function resolveOutputMode(options: RenderOwnOptions): OutputMode {
  const requested = options.resolveAs;
  if (requested !== undefined && requested !== 'url' && requested !== 'file') {
    throw invalidArgument("--resolve-as must be 'url' or 'file'.");
  }
  const resolveAs = requested ?? (options.out !== undefined ? 'file' : 'url');
  if (resolveAs === 'url') return { resolveAs: 'url' };
  if (options.out === undefined) throw invalidArgument('--resolve-as file requires --out <path>.');
  return { resolveAs: 'file', savePath: options.out };
}
