/**
 * `dgr render`: renders a template from `--spec <file>` or from
 * `--template`/`--preset`/`--encode`, then prints the read URL of each of
 * its outputs (the default) or saves its one output to `--out`. The first
 * Ctrl+C cancels the job, or stops the save once the job has finished, and,
 * once that rejects, waits up to ten seconds for the cancel request to be
 * sent before setting the exit code — 130 for the cancellation; a second
 * Ctrl+C ends the process at once.
 */

import { Command } from 'commander';
import type { Asset } from '../../core/asset.js';
import { AudioVideoError } from '../../core/errors.js';
import type { RenderRequest } from '../../dgr/schemas.js';
import { resolveClient } from '../client.js';
import { invalidArgument } from '../errors.js';
import { exitCodeForError } from '../exit-codes.js';
import { printFailure, printSuccess, type FailureContext } from '../output.js';
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

const STORAGE_HELP = [
  '',
  'Storage: a render writes its output to --storage (or DGR_STORAGE) — one of',
  "'s3://<bucket>[/<prefix>]', 'azure://<container>[/<prefix>]' or 'aio-files' —",
  'and uploads a local --template or an .epr preset there, including the one an',
  '--encode config becomes. Only a --spec whose outputs name their own',
  'destinations, whose inputs are all URLs and whose presets are native needs no',
  'storage.',
].join('\n');

export function buildRenderCommand(runtime: CliRuntime): Command {
  const command = new Command('render');
  command
    .description("Renders a template and prints each output's read URL, or saves its one output.")
    .option('--spec <file>', 'a render spec as JSON: { source, presets, outputs }')
    .option('--template <urlOrPath>', 'the template to render — an http(s) URL or a local file')
    .option('--preset <nameOrIdOrPath>', 'a catalog name, a native presetId, or an .epr file path')
    .option('--encode <json>', 'a full encode config as JSON, e.g. \'{"codec":"hevc"}\'')
    .option('--out <path>', 'saves the output of a render with one output to this local path')
    .option(
      '--resolve-as <mode>',
      "'url' (default) prints each output's read URL; 'file' saves the one output to --out",
    )
    .addHelpText('after', STORAGE_HELP)
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
  // Stops the save of a finished output; a job that has settled ignores its own cancel().
  const saving = new AbortController();
  // The finished job and its output, once a failure can only concern saving that output.
  let finished: FailureContext | undefined;
  let stopListening = (): void => undefined;
  try {
    const spec = buildSpec(options);
    const mode = resolveOutputMode(options);
    if (mode.resolveAs === 'file') requireOneOutput(spec);
    const client = resolveClient(runtime, options, { storage: true });
    const job = client.render(spec);
    stopListening = runtime.onInterrupt(() => {
      if (!interrupted) {
        interrupted = true;
        runtime.stderr.write('Cancelling the render...\n');
        cancelRequest = job.cancel();
        saving.abort();
      } else if (!exited) {
        exited = true;
        runtime.forceExit(130);
      }
    });
    const rendered = await job;
    const assets = Array.isArray(rendered) ? rendered : [rendered];
    let output: string | string[];
    if (mode.resolveAs === 'file') {
      const asset = onlyOutput(assets);
      finished = { jobId: job.jobId, readUrl: asset.toJSON().url };
      await asset.save(mode.savePath, { signal: saving.signal });
      output = mode.savePath;
    } else {
      const urls = assets.map((asset) => asset.url);
      output = urls.length === 1 && urls[0] !== undefined ? urls[0] : urls;
    }
    printSuccess(runtime, json, Array.isArray(output) ? output.join('\n') : output, {
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
    printFailure(runtime, json, error, finished);
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

/**
 * Refuses a spec that lists several outputs before anything is submitted:
 * `--out` names one file. A spec whose `outputs` is not an array is left to
 * `client.render()`'s own validation.
 */
function requireOneOutput(spec: RenderRequest): void {
  const outputs: unknown = spec.outputs;
  if (Array.isArray(outputs) && outputs.length > 1) throw severalOutputs(outputs.length);
}

/** A finished render's one output, as `requireOneOutput` let through. */
function onlyOutput(assets: readonly Asset[]): Asset {
  const [asset] = assets;
  if (asset === undefined || assets.length !== 1) throw severalOutputs(assets.length);
  return asset;
}

function severalOutputs(count: number): AudioVideoError {
  return invalidArgument(
    `--out saves a render with one output, and this spec has ${count}: ` +
      "leave out --out to print each output's read URL.",
  );
}
