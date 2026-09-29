/**
 * The render pipeline behind `render()`, in the three steps a pooled call
 * runs it: validate the spec and resolve its presets; stage generated `.epr`
 * files, allocate output locations and build the wire body — both before the
 * job takes a pool slot; and map the terminal status back onto the spec's
 * outputs as {@link Asset}s. `buildRenderBody` alone produces the wire shape.
 */

import * as z from 'zod';
import { Asset } from '../core/asset.js';
import { AudioVideoError } from '../core/errors.js';
import type { JobItemLike, JobMeta, JobStatusLike } from '../core/job.js';
import type { StorageProvider } from '../core/storage.js';
import { NAMED, nameForPresetId } from '../presets/catalog.js';
import { describeIssues } from '../presets/codecs.js';
import { buildRenderBody } from './build-body.js';
import { resolvePreset, toPreset, type Preset, type PresetInput } from './preset.js';
import {
  PresetRefSchema,
  RenderRequestSchema,
  type EncodeConfig,
  type PresetRef,
  type RenderRequestOutput,
  type RenderSpec,
} from './schemas.js';
import type { RenderBodyWire } from './types.js';

/** A template to render or describe: an http(s) URL as a string, a `URL`, or `{ url }`. */
export type TemplateSource = string | URL | { url: string };

/** @internal A preset as validation resolves it, before anything is staged. */
export interface PreparedPreset {
  /** The resolved reference — absent while {@link PreparedPreset.xml} still needs staging. */
  readonly ref?: PresetRef;
  /** `.epr` XML {@link materializeRender} stages before the job is submitted. */
  readonly xml?: string;
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
  readonly source: string;
  readonly presets: readonly PreparedPreset[];
  readonly assets?: string[];
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
 * its presets and variations, and resolves every preset — leaving the staging
 * of any `.epr` to {@link materializeRender}. Performs no remote call.
 *
 * @throws {@link AudioVideoError} `invalid_argument` for an invalid spec, or
 *   for a preset that needs staging when no storage is configured;
 *   `invalid_preset` for a preset that cannot resolve.
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
  const presets = await Promise.all(
    spec.presets.map((entry, index) => preparePreset(entry, `presets[${index}]`)),
  );
  requireStorageForStaging(presets, storage);
  return {
    source: spec.source,
    presets,
    ...(spec.assets !== undefined ? { assets: spec.assets } : {}),
    ...(spec.variations !== undefined ? { variations: spec.variations } : {}),
    outputs,
  };
}

/**
 * @internal Validates a fluent render: one source, one preset, one output
 * whose location storage allocates in {@link materializeRender}. Performs no
 * remote call.
 *
 * @throws {@link AudioVideoError} `invalid_argument` when no preset is chosen,
 *   no storage is configured, or the source is not a template URL;
 *   `invalid_preset` for a preset that cannot resolve.
 */
export async function prepareFluent(
  input: FluentRenderInput,
  storage: StorageProvider | undefined,
): Promise<PreparedRender> {
  const source = templateUrl(input.source, 'The render source');
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
 * @internal Stages every deferred `.epr` and allocates every output that has
 * no destination, then builds the wire body. Runs before the job takes a
 * pool slot, so no storage call ever waits on the pool.
 *
 * @throws {@link AudioVideoError} `storage_failed` when the storage provider
 *   throws or resolves with something other than the URLs it owes.
 */
export async function materializeRender(
  prepared: PreparedRender,
  storage: StorageProvider | undefined,
): Promise<{ body: RenderBodyWire; outputs: MaterializedOutput[] }> {
  const [presets, outputs] = await Promise.all([
    Promise.all(
      prepared.presets.map(
        (preset, index) => preset.ref ?? stageEpr(storage, preset.xml ?? '', index),
      ),
    ),
    Promise.all(prepared.outputs.map((output) => materializeOutput(output, storage))),
  ]);
  const spec: RenderSpec = {
    source: prepared.source,
    presets,
    ...(prepared.assets !== undefined ? { assets: prepared.assets } : {}),
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
 */
export function renderAssets(
  terminal: JobStatusLike,
  meta: JobMeta,
  outputs: readonly MaterializedOutput[],
): Asset[] {
  const wire = Array.isArray(terminal.outputs) ? terminal.outputs : [];
  const claimed = new Set<number>();
  return outputs.map((output, index) => {
    const position = matchWireOutput(wire, output, claimed);
    if (position !== undefined) claimed.add(position);
    const item = position === undefined ? undefined : meta.perItem[position];
    return new Asset({ url: output.readUrl, meta: assetMeta(meta, index, item) });
  });
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
  if (typeof value === 'string' || value instanceof URL) return true;
  return isRecord(value) && 'url' in value && !('source' in value);
}

/**
 * @internal The URL a {@link TemplateSource} names.
 *
 * @param what - Names the value in the error message, e.g. `'The render source'`.
 * @throws {@link AudioVideoError} `invalid_argument` for anything else, or an empty URL.
 */
export function templateUrl(source: unknown, what: string): string {
  const url =
    source instanceof URL
      ? source.href
      : typeof source === 'string'
        ? source
        : isRecord(source) && typeof source.url === 'string'
          ? source.url
          : undefined;
  if (url === undefined || url.trim() === '') {
    throw invalidArgument(
      `${what} must be a template URL — a non-empty string, a URL, or { url } — got ${typeName(source)}.`,
    );
  }
  return url;
}

/** @internal An {@link AudioVideoError} with `code: 'invalid_argument'`. */
export function invalidArgument(message: string, cause?: unknown): AudioVideoError {
  return new AudioVideoError({ message, code: 'invalid_argument', cause });
}

/** Placeholder `resolvePreset` receives while the real staging waits for {@link materializeRender}; never sent anywhere. */
const DEFERRED_STAGE_URL = 'deferred:epr';

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
  return {
    variationIndex,
    presetIndex: output.presetIndex,
    ...(output.fileName !== undefined ? { fileName: output.fileName } : {}),
    destination: output.destination,
    ...(output.readUrl !== undefined ? { readUrl: output.readUrl } : {}),
  };
}

/**
 * Resolves one preset input: a `{ presetId }` / `{ url }` reference passes
 * through; anything else goes through `toPreset` and `resolvePreset`, with any
 * `.epr` XML kept for staging later. Errors name the preset they came from.
 */
async function preparePreset(
  entry: PresetInput | PresetRef,
  where: string,
): Promise<PreparedPreset> {
  try {
    const ref = PresetRefSchema.safeParse(entry);
    if (ref.success) return preparedRef(ref.data);
    return await preparedPreset(toPreset(entry as PresetInput));
  } catch (error) {
    throw error instanceof AudioVideoError
      ? new AudioVideoError({
          message: `${where}: ${error.message}`,
          code: error.code,
          cause: error,
        })
      : error;
  }
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

function requireStorageForStaging(
  presets: readonly PreparedPreset[],
  storage: StorageProvider | undefined,
): void {
  const index = presets.findIndex((preset) => preset.xml !== undefined);
  if (index === -1 || storage !== undefined) return;
  throw invalidArgument(
    `presets[${index}] resolves to an .epr that must be staged for DGR to read, and no storage ` +
      'is configured: pass a StorageProvider as the storage option of configure() or ' +
      "createClient(), or use a native preset — a catalog name such as 'h264Land1080pHq' or " +
      "'prores', or a DGR presetId.",
  );
}

async function stageEpr(
  storage: StorageProvider | undefined,
  xml: string,
  index: number,
): Promise<PresetRef> {
  if (storage === undefined) {
    throw storageFailure(`presets[${index}] needs staging, and no storage is configured.`);
  }
  let url: unknown;
  try {
    url = await storage.stageRead(Buffer.from(xml), { contentType: 'application/xml' });
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
    slot = await storage.allocateOutput();
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

/**
 * @internal A storage provider's failure as the SDK reports it: an
 * {@link AudioVideoError} the provider threw passes through; anything else is
 * wrapped with `code: 'storage_failed'`.
 */
export function storageFailure(message: string, cause?: unknown): AudioVideoError {
  if (cause instanceof AudioVideoError) return cause;
  return new AudioVideoError({ message, code: 'storage_failed', cause });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
