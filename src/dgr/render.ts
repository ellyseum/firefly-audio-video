/**
 * The render pipeline behind `render()`, in the three steps a pooled call
 * runs it: validate the spec, resolve its presets and read which inputs need
 * uploading — checking that storage is there for every one of them — before
 * the job asks for a pool slot; upload those inputs, stage generated `.epr`
 * files, allocate output locations and build the wire body once the job holds
 * its slot, just before the submit; and map the terminal status back onto the
 * spec's outputs as {@link Asset}s.
 */

import * as z from 'zod';
import { Asset } from '../core/asset.js';
import { AudioVideoError } from '../core/errors.js';
import type { JobItemLike, JobMeta, JobStatusLike } from '../core/job.js';
import {
  classifyAsset,
  isReadable,
  noStorage,
  normalizeAsset,
  storageFailure,
  type StageInput,
  type StorageProvider,
} from '../core/storage.js';
import { NAMED, nameForPresetId } from '../presets/catalog.js';
import { describeIssues } from '../presets/codecs.js';
import { buildRenderBody, checkAssetIndices } from './build-body.js';
import { resolvePreset, toPreset, type Preset, type PresetInput } from './preset.js';
import {
  PresetRefSchema,
  RenderRequestSchema,
  TemplateSourceSchema,
  type EncodeConfig,
  type PresetRef,
  type PresetRefInput,
  type RenderRequestOutput,
  type RenderSpec,
  type TemplateSource,
} from './schemas.js';
import type { RenderBodyWire } from './types.js';

/**
 * @internal A render input as validation leaves it: a URL DGR reads as it is,
 * or an input {@link materializeRender} uploads through storage first.
 */
export type PreparedAsset = { readonly url: string } | { readonly stage: StageInput };

/** @internal A preset as validation resolves it, before anything is staged. */
export interface PreparedPreset {
  /** The resolved reference — absent while {@link PreparedPreset.xml} or {@link PreparedPreset.stage} still needs staging. */
  readonly ref?: PresetRef;
  /** `.epr` XML {@link materializeRender} stages before the job is submitted. */
  readonly xml?: string;
  /** An `.epr` given as a file, a `Buffer` or a `Readable`, which {@link materializeRender} uploads before the job is submitted. */
  readonly stage?: StageInput;
  /** What the call's log record names the preset: its DGR `presetId`, else its catalog name, else its kind. */
  readonly label: string;
  /** The preset's codec, when known. */
  readonly codec?: string;
  /** The preset's frame size as `'WxH'`, when it fixes one. */
  readonly resolution?: string;
}

/** @internal An output as validation leaves it, before any storage call. */
export interface PreparedOutput {
  readonly variationIndex: number;
  readonly presetIndex: number;
  readonly fileName?: string;
  /** The presigned write URL — absent when storage allocates one before the job is submitted. */
  readonly destination?: string;
  readonly readUrl?: string;
}

/** @internal A render validated and normalized, before any storage call. */
export interface PreparedRender {
  readonly source: PreparedAsset;
  readonly presets: readonly PreparedPreset[];
  readonly assets?: readonly PreparedAsset[];
  readonly variations?: RenderSpec['variations'];
  readonly outputs: readonly PreparedOutput[];
}

/** @internal An output as submitted: where DGR writes it and where the asset is read from. */
export interface MaterializedOutput {
  readonly variationIndex: number;
  readonly presetIndex: number;
  readonly fileName?: string;
  readonly destination: string;
  readonly readUrl: string;
}

/** @internal The input a fluent render prepares from. */
export interface FluentRenderInput {
  readonly source: TemplateSource;
  readonly preset: PresetInput | undefined;
  readonly fileName?: string;
}

/**
 * @internal Validates a `render()` spec, checks every output's indices against
 * its presets and variations and every `assetIndex` against its assets,
 * resolves every preset, and reads which inputs need uploading — leaving
 * every upload, `.epr` staging and output allocation to
 * {@link materializeRender}. Consults only the local filesystem, to tell a
 * file path from a mistyped one; performs no remote call.
 *
 * @throws {@link AudioVideoError} `invalid_argument` for an invalid spec, an
 *   input that is neither an http(s) URL nor a local file, a `Buffer` or a
 *   `Readable`, or anything that needs storage — an input to upload, an
 *   `.epr` to stage, an output with no destination — when none is
 *   configured; `invalid_preset` for a preset that cannot resolve.
 */
export async function prepareRequest(
  request: unknown,
  storage: StorageProvider | undefined,
): Promise<PreparedRender> {
  const parsed = RenderRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw invalidArgument(`Invalid render spec: ${describeIssues(parsed.error)}`, parsed.error);
  }
  const spec = parsed.data;
  const variationCount = spec.variations?.length ?? 0;
  const outputs = spec.outputs.map((output, index) =>
    prepareOutput(output, index, spec.presets.length, variationCount),
  );
  checkIndices(spec);
  const presets = await Promise.all(
    spec.presets.map((entry, index) => preparePreset(entry, `presets[${index}]`)),
  );
  const source = await prepareAsset(spec.source, 'source');
  const assets =
    spec.assets === undefined
      ? undefined
      : await Promise.all(
          spec.assets.map((asset, index) => prepareAsset(asset, `assets[${index}]`)),
        );
  const prepared: PreparedRender = {
    source,
    presets,
    ...(assets !== undefined ? { assets } : {}),
    ...(spec.variations !== undefined ? { variations: spec.variations } : {}),
    outputs,
  };
  requireStorage(prepared, storage);
  return prepared;
}

/**
 * @internal Validates a fluent render: one source, read by
 * {@link prepareTemplateSource} exactly as a spec's `source` is; one preset;
 * one output whose location storage allocates in {@link materializeRender}.
 * Consults only the local filesystem; performs no remote call.
 *
 * @throws {@link AudioVideoError} `invalid_argument` when the source is one
 *   a spec's `source` would refuse, no preset is chosen, or no storage is
 *   configured; `invalid_preset` for a preset that cannot resolve.
 */
export async function prepareFluent(
  input: FluentRenderInput,
  storage: StorageProvider | undefined,
): Promise<PreparedRender> {
  const source = await prepareTemplateSource(input.source);
  if (input.preset === undefined) {
    throw invalidArgument(
      'No preset is chosen: pick one on the builder — render(url).prores, ' +
        '.hevc1080p10bit or .h264Land1080pHq — or pass { preset }.',
    );
  }
  if (storage === undefined) {
    throw invalidArgument(
      'A fluent render allocates its output through storage, and no storage is configured: ' +
        'pass a StorageProvider as the storage option of configure() or createClient(), or ' +
        'call render() with a spec whose output names its destination.',
    );
  }
  if (input.fileName !== undefined && (typeof input.fileName !== 'string' || !input.fileName)) {
    throw invalidArgument('fileName must be a non-empty string when provided.');
  }
  return {
    source,
    presets: [await preparePreset(input.preset, 'The preset')],
    outputs: [
      {
        variationIndex: 0,
        presetIndex: 0,
        ...(input.fileName ? { fileName: input.fileName } : {}),
      },
    ],
  };
}

/**
 * @internal Uploads every input that needs it, stages every deferred `.epr`,
 * and allocates every output that has no destination — concurrently — then
 * builds the wire body. Runs once the job holds its pool slot, just before
 * the submit, so every staged URL is fresh when DGR is sent it; it never asks
 * the pool for another slot. `signal` goes to every storage call.
 *
 * @throws {@link AudioVideoError} `storage_failed` when the storage provider
 *   throws or resolves with something other than the URLs it owes (an
 *   {@link AudioVideoError} it throws keeps its own code); each message names
 *   the field it came from.
 */
export async function materializeRender(
  prepared: PreparedRender,
  storage: StorageProvider | undefined,
  signal: AbortSignal,
): Promise<{ body: RenderBodyWire; outputs: MaterializedOutput[] }> {
  const [source, assets, presets, outputs] = await Promise.all([
    materializeAsset(prepared.source, storage, 'source', { signal }),
    prepared.assets === undefined
      ? undefined
      : Promise.all(
          prepared.assets.map((asset, index) =>
            materializeAsset(asset, storage, `assets[${index}]`, { signal }),
          ),
        ),
    Promise.all(
      prepared.presets.map((preset, index) => materializePreset(preset, storage, index, signal)),
    ),
    Promise.all(prepared.outputs.map((output) => materializeOutput(output, storage, signal))),
  ]);
  const spec: RenderSpec = {
    source,
    presets,
    ...(assets !== undefined ? { assets } : {}),
    ...(prepared.variations !== undefined ? { variations: prepared.variations } : {}),
    outputs: outputs.map((output) => ({
      variationIndex: output.variationIndex,
      presetIndex: output.presetIndex,
      ...(output.fileName !== undefined ? { fileName: output.fileName } : {}),
      destination: output.destination,
    })),
  };
  return { body: buildBody(spec), outputs };
}

/**
 * @internal One {@link Asset} per submitted output, in the spec's order. Each
 * asset's URL is its output's read URL. The terminal status lists its outputs
 * in no particular order, with `variationIndex` and `presetIndex` as strings,
 * so each is matched to its spec output by that numeric pair — never by
 * position — and outputs sharing a pair are told apart by destination. An
 * asset's `meta` carries its own output's timing.
 *
 * @throws {@link AudioVideoError} `invalid_response`, `jobId` set, when the
 *   terminal status carries no `outputs` array, when a submitted output has
 *   no matching entry in it, or when an entry in it matches no submitted
 *   output — the service reported something other than what was submitted.
 *   The message names the mismatched `(variationIndex, presetIndex)` pairs,
 *   never a URL.
 */
export function renderAssets(
  terminal: JobStatusLike,
  meta: JobMeta,
  outputs: readonly MaterializedOutput[],
): Asset[] {
  const wire = terminal.outputs;
  if (!Array.isArray(wire)) {
    throw outputMismatch(meta.jobId, 'The terminal status carried no outputs.');
  }
  const claimed = new Set<number>();
  const assets: Asset[] = [];
  const unmatched: MaterializedOutput[] = [];
  for (const [index, output] of outputs.entries()) {
    const position = matchWireOutput(wire, output, claimed);
    if (position === undefined) {
      unmatched.push(output);
      continue;
    }
    claimed.add(position);
    assets.push(
      new Asset({ url: output.readUrl, meta: assetMeta(meta, index, meta.perItem[position]) }),
    );
  }
  const unclaimed = wire.filter((_entry, position) => !claimed.has(position));
  if (unmatched.length > 0 || unclaimed.length > 0) {
    throw outputMismatch(meta.jobId, mismatchMessage(unmatched, unclaimed));
  }
  return assets;
}

/**
 * @internal The log fields a render's presets contribute: their labels,
 * codecs and frame sizes, each distinct value once, comma-joined in
 * `presets[]` order.
 */
export function presetLogFields(presets: readonly PreparedPreset[]): {
  preset?: string;
  codec?: string;
  resolution?: string;
} {
  return defined({
    preset: joinDistinct(presets.map((preset) => preset.label)),
    codec: joinDistinct(presets.map((preset) => preset.codec)),
    resolution: joinDistinct(presets.map((preset) => preset.resolution)),
  });
}

/** @internal True for a value `render()` reads as a template source rather than a spec object. */
export function isTemplateSource(value: unknown): value is TemplateSource {
  if (isStageInputForm(value)) return true;
  return isRecord(value) && 'url' in value && !('source' in value);
}

/**
 * @internal Validates a template source — what `render(source)` and
 * `describe()` take — and reads whether it needs uploading, by the rule
 * {@link prepareRequest} applies to a spec's `source`: an http(s) URL is used
 * as it is; a file path, a `file:` URL, a `Buffer` or a `Readable` is kept for
 * staging. Consults only the local filesystem, to tell a file path from a
 * mistyped one; performs no remote call. Errors name `source`.
 *
 * @throws {@link AudioVideoError} `invalid_argument` for anything a spec's
 *   `source` would refuse: a path that names no file, a string that is not
 *   an http(s) URL, a URL of another scheme, or any other kind of value.
 */
export async function prepareTemplateSource(source: unknown): Promise<PreparedAsset> {
  const parsed = TemplateSourceSchema.safeParse(source);
  if (!parsed.success) throw invalidArgument(describeIssues(parsed.error), parsed.error);
  const input = isStageInputForm(parsed.data) ? parsed.data : parsed.data.url;
  return prepareAsset(input, 'source');
}

/**
 * @internal The URL DGR reads a template source from once the job holds its
 * pool slot: as it is, or uploaded through `storage` first when
 * {@link prepareTemplateSource} kept it for staging. `signal` aborts the
 * upload.
 *
 * @throws {@link AudioVideoError} `storage_failed` when the upload fails.
 */
export function materializeTemplateSource(
  source: PreparedAsset,
  storage: StorageProvider | undefined,
  signal: AbortSignal,
): Promise<string> {
  return materializeAsset(source, storage, 'source', { signal });
}

/** @internal An {@link AudioVideoError} with `code: 'invalid_argument'`. */
export function invalidArgument(message: string, cause?: unknown): AudioVideoError {
  return new AudioVideoError({ message, code: 'invalid_argument', cause });
}

/** Placeholder `resolvePreset` receives while the real staging waits for {@link materializeRender}; never sent anywhere. */
const DEFERRED_STAGE_URL = 'deferred:epr';

/** The content type a staged `.epr` is uploaded with. */
const EPR_CONTENT_TYPE = 'application/xml';

function prepareOutput(
  output: RenderRequestOutput,
  index: number,
  presetCount: number,
  variationCount: number,
): PreparedOutput {
  const variationIndex = output.variationIndex ?? 0;
  if (output.presetIndex >= presetCount) {
    throw invalidArgument(
      `outputs[${index}].presetIndex is ${output.presetIndex}, but the spec has ${plural(presetCount, 'preset')}.`,
    );
  }
  if (variationIndex >= Math.max(1, variationCount)) {
    throw invalidArgument(
      variationCount === 0
        ? `outputs[${index}].variationIndex is ${variationIndex}, but the spec has no variations, so it must be 0.`
        : `outputs[${index}].variationIndex is ${variationIndex}, but the spec has ${plural(variationCount, 'variation')}.`,
    );
  }
  if (output.destination === undefined && output.readUrl !== undefined) {
    throw invalidArgument(
      `outputs[${index}] has a readUrl but no destination: an output without a destination ` +
        'gets both of its URLs from storage, so leave readUrl out too.',
    );
  }
  return {
    variationIndex,
    presetIndex: output.presetIndex,
    ...(output.fileName !== undefined ? { fileName: output.fileName } : {}),
    ...(output.destination !== undefined ? { destination: output.destination } : {}),
    ...(output.readUrl !== undefined ? { readUrl: output.readUrl } : {}),
  };
}

/**
 * Resolves one preset input: a `{ presetId }` reference passes through; a
 * `{ url }` reference passes through when `url` is an http(s) URL and is kept
 * for staging when it names a file, a `Buffer` or a `Readable`; anything else
 * goes through `toPreset` and `resolvePreset`, with any `.epr` XML kept for
 * staging later. Errors name the preset they came from.
 */
async function preparePreset(
  entry: PresetInput | PresetRefInput,
  where: string,
): Promise<PreparedPreset> {
  if (isUrlRef(entry)) return prepareUrlRef(entry.url, `${where}.url`);
  try {
    const ref = PresetRefSchema.safeParse(entry);
    if (ref.success) return preparedRef(ref.data);
    return await preparedPreset(toPreset(entry as PresetInput));
  } catch (error) {
    throw fieldError(where, error);
  }
}

/** True for a `{ url }` preset reference: a plain object whose one key is `url`. */
function isUrlRef(entry: unknown): entry is { url: unknown } {
  return isRecord(entry) && Object.keys(entry).length === 1 && 'url' in entry;
}

/** A `{ url }` reference: used as it is for an http(s) URL, kept for staging for anything that must be uploaded. */
async function prepareUrlRef(url: unknown, where: string): Promise<PreparedPreset> {
  const asset = await prepareAsset(url as StageInput, where);
  return 'url' in asset ? { ref: { url: asset.url }, label: 'epr' } : { ...asset, label: 'epr' };
}

function preparedRef(ref: PresetRef): PreparedPreset {
  if ('url' in ref) return { ref, label: 'epr' };
  const name = nameForPresetId(ref.presetId);
  return { ref, label: ref.presetId, ...configFields(name && NAMED[name].config) };
}

async function preparedPreset(preset: Preset): Promise<PreparedPreset> {
  const deferred: { xml?: string } = {};
  const resolved = await resolvePreset(preset, {
    stage: async (xml) => {
      deferred.xml = xml;
      return DEFERRED_STAGE_URL;
    },
  });
  const json = preset.toJSON();
  return {
    ...(deferred.xml === undefined ? { ref: resolved } : { xml: deferred.xml }),
    label: 'presetId' in resolved ? resolved.presetId : (json.name ?? json.kind),
    ...configFields(json.config),
  };
}

function configFields(config: Readonly<Partial<EncodeConfig>> | undefined): {
  codec?: string;
  resolution?: string;
} {
  const resolution = config?.resolution;
  return defined({
    codec: config?.codec,
    resolution:
      typeof resolution === 'object' ? `${resolution.width}x${resolution.height}` : resolution,
  });
}

/**
 * Checks that storage is configured when anything in `prepared` needs it,
 * naming the first thing that does: an input to upload, an `.epr` to stage,
 * or an output to allocate.
 */
function requireStorage(prepared: PreparedRender, storage: StorageProvider | undefined): void {
  if (storage !== undefined) return;
  if ('stage' in prepared.source) throw noStorage('source');
  const asset = prepared.assets?.findIndex((entry) => 'stage' in entry) ?? -1;
  if (asset !== -1) throw noStorage(`assets[${asset}]`);
  for (const [index, preset] of prepared.presets.entries()) {
    if (preset.stage !== undefined) throw noStorage(`presets[${index}].url`);
    if (preset.xml !== undefined) {
      throw invalidArgument(
        `presets[${index}] resolves to an .epr that must be staged for DGR to read, and no storage ` +
          'is configured: pass a StorageProvider as the storage option of configure() or ' +
          "createClient(), or use a native preset — a catalog name such as 'h264Land1080pHq' or " +
          "'prores', or a DGR presetId.",
      );
    }
  }
  const output = prepared.outputs.findIndex((entry) => entry.destination === undefined);
  if (output !== -1) {
    throw invalidArgument(
      `outputs[${output}] has no destination, and no storage is configured to allocate one: ` +
        'give it a destination, or pass a StorageProvider as the storage option of configure() ' +
        'or createClient().',
    );
  }
}

/** A render input as validation leaves it; errors name `where`. */
async function prepareAsset(input: StageInput, where: string): Promise<PreparedAsset> {
  try {
    const asset = await classifyAsset(input);
    return asset.kind === 'url' ? { url: asset.url } : { stage: input };
  } catch (error) {
    throw fieldError(where, error);
  }
}

/** The URL DGR reads a prepared input from, uploading it first when it needs that; errors name `where`. */
async function materializeAsset(
  asset: PreparedAsset,
  storage: StorageProvider | undefined,
  where: string,
  opts: { contentType?: string; signal: AbortSignal },
): Promise<string> {
  if ('url' in asset) return asset.url;
  try {
    return await normalizeAsset(asset.stage, storage, opts);
  } catch (error) {
    throw fieldError(where, error);
  }
}

/** The reference a prepared preset is submitted as, staging its `.epr` first when it has one to stage. */
async function materializePreset(
  preset: PreparedPreset,
  storage: StorageProvider | undefined,
  index: number,
  signal: AbortSignal,
): Promise<PresetRef> {
  if (preset.ref !== undefined) return preset.ref;
  if (preset.stage !== undefined) {
    const url = await materializeAsset({ stage: preset.stage }, storage, `presets[${index}].url`, {
      contentType: EPR_CONTENT_TYPE,
      signal,
    });
    return { url };
  }
  return stageEpr(storage, preset.xml ?? '', index, signal);
}

/**
 * `checkAssetIndices`, with a variable whose `assetIndex` points past the end
 * of `assets` reported as `invalid_argument` — before anything is uploaded.
 */
function checkIndices(spec: Parameters<typeof checkAssetIndices>[0]): void {
  try {
    checkAssetIndices(spec);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw invalidArgument(`Invalid render spec: ${describeIssues(error)}`, error);
    }
    throw error;
  }
}

/** `error` with `where` in front of its message when it is an {@link AudioVideoError}, the original kept as `cause`. */
function fieldError(where: string, error: unknown): unknown {
  return error instanceof AudioVideoError
    ? new AudioVideoError({ message: `${where}: ${error.message}`, code: error.code, cause: error })
    : error;
}

async function stageEpr(
  storage: StorageProvider | undefined,
  xml: string,
  index: number,
  signal: AbortSignal,
): Promise<PresetRef> {
  if (storage === undefined) {
    throw storageFailure(`presets[${index}] needs staging, and no storage is configured.`);
  }
  let url: unknown;
  try {
    url = await storage.stageRead(Buffer.from(xml), { contentType: EPR_CONTENT_TYPE, signal });
  } catch (cause) {
    throw storageFailure(`Staging the .epr for presets[${index}] failed.`, cause);
  }
  if (typeof url !== 'string' || url === '') {
    throw storageFailure(
      `storage.stageRead() resolved with ${typeName(url)} instead of the staged .epr's URL.`,
    );
  }
  return { url };
}

async function materializeOutput(
  output: PreparedOutput,
  storage: StorageProvider | undefined,
  signal: AbortSignal,
): Promise<MaterializedOutput> {
  const { variationIndex, presetIndex, fileName } = output;
  const named = fileName !== undefined ? { fileName } : {};
  if (output.destination !== undefined) {
    return {
      variationIndex,
      presetIndex,
      ...named,
      destination: output.destination,
      readUrl: output.readUrl ?? output.destination,
    };
  }
  if (storage === undefined) {
    throw storageFailure('The output has no destination, and no storage is configured.');
  }
  let slot: unknown;
  try {
    slot = await storage.allocateOutput({ signal });
  } catch (cause) {
    throw storageFailure('Allocating the output location failed.', cause);
  }
  const { writeUrl, readUrl } = isRecord(slot) ? slot : {};
  if (typeof writeUrl !== 'string' || !writeUrl || typeof readUrl !== 'string' || !readUrl) {
    throw storageFailure(
      'storage.allocateOutput() must resolve with { writeUrl, readUrl }, both non-empty strings.',
    );
  }
  return { variationIndex, presetIndex, ...named, destination: writeUrl, readUrl };
}

/** `buildRenderBody`, with a validation failure reported as `invalid_argument`. */
function buildBody(spec: RenderSpec): RenderBodyWire {
  try {
    return buildRenderBody(spec);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw invalidArgument(`Invalid render spec: ${describeIssues(error)}`, error);
    }
    throw error;
  }
}

/**
 * The position in the terminal `outputs[]` of the entry for `output`: the
 * first unclaimed entry with the same `variationIndex` and `presetIndex`,
 * preferring one whose destination matches.
 */
function matchWireOutput(
  wire: readonly JobItemLike[],
  output: MaterializedOutput,
  claimed: ReadonlySet<number>,
): number | undefined {
  let first: number | undefined;
  for (const [position, entry] of wire.entries()) {
    if (claimed.has(position) || !isRecord(entry)) continue;
    if (wireIndex(entry.variationIndex) !== output.variationIndex) continue;
    if (wireIndex(entry.presetIndex) !== output.presetIndex) continue;
    const destination = isRecord(entry.destination) ? entry.destination.url : undefined;
    if (destination === output.destination) return position;
    first ??= position;
  }
  return first;
}

/**
 * A wire index as a number: the service sends `variationIndex` and
 * `presetIndex` as strings. An absent index reads as `0`, the request's own
 * default; anything that is not a non-negative integer reads as `-1`, which
 * matches no output.
 */
function wireIndex(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\s*\d+\s*$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

/** @internal An {@link AudioVideoError} `code: 'invalid_response'`, naming the render job it came from. */
function outputMismatch(jobId: string | undefined, message: string): AudioVideoError {
  return new AudioVideoError({ message, code: 'invalid_response', jobId });
}

/** Every side of an output mismatch, by its `(variationIndex, presetIndex)` pair — never a URL. */
function mismatchMessage(
  unmatched: readonly MaterializedOutput[],
  unclaimed: readonly JobItemLike[],
): string {
  const parts: string[] = [];
  if (unmatched.length > 0) {
    const pairs = unmatched.map((output) => pairLabel(output.variationIndex, output.presetIndex));
    parts.push(`the spec declared ${pairs.join(', ')} with no matching output in the response`);
  }
  if (unclaimed.length > 0) {
    parts.push(
      `the response reported ${unclaimed.map(wirePairLabel).join(', ')} the spec did not declare`,
    );
  }
  return `The rendered outputs did not match the spec: ${parts.join('; ')}.`;
}

/** A `(variationIndex, presetIndex)` pair, formatted for an error message. */
function pairLabel(variationIndex: number, presetIndex: number): string {
  return `(variationIndex=${variationIndex}, presetIndex=${presetIndex})`;
}

/** A wire `outputs[]` entry's `(variationIndex, presetIndex)` pair, coerced the same way matching does. */
function wirePairLabel(entry: JobItemLike): string {
  if (!isRecord(entry)) return pairLabel(-1, -1);
  return pairLabel(wireIndex(entry.variationIndex), wireIndex(entry.presetIndex));
}

/** An asset's timing: the job's ID and acceptance time, with its own output's durations. */
function assetMeta(
  meta: JobMeta,
  index: number,
  item: JobMeta['perItem'][number] | undefined,
): JobMeta {
  const durations =
    item === undefined
      ? {}
      : defined({ queueMs: item.queueMs, renderMs: item.renderMs, totalMs: item.totalMs });
  return {
    jobId: meta.jobId,
    ...defined({ createdAt: meta.createdAt }),
    ...durations,
    perItem: item === undefined ? [] : [{ index, ...durations }],
  };
}

/** Each distinct defined value once, comma-joined in order; `undefined` when there is none. */
function joinDistinct(values: readonly (string | undefined)[]): string | undefined {
  const distinct = [...new Set(values.filter((value): value is string => value !== undefined))];
  return distinct.length > 0 ? distinct.join(',') : undefined;
}

/** `record` without its `undefined` entries. */
function defined<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** A value's kind for an error message — never the value itself, which may be a presigned URL. */
function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return value === '' ? 'an empty string' : 'a string';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/** True for a value in a form a render input takes on its own: a string, a `URL`, a `Buffer` or a `Readable`. */
function isStageInputForm(value: unknown): value is StageInput {
  return (
    typeof value === 'string' || value instanceof URL || Buffer.isBuffer(value) || isReadable(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
