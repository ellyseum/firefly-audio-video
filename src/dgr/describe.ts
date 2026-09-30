/**
 * The describe capability's input and result shapes: what `describe()` takes,
 * the wire body `POST /v1/templates/describe` expects, and the
 * {@link TemplateDescription} a finished describe job resolves with.
 */

import type { JobStatusLike } from '../core/job.js';
import { isReadable, noStorage, type StorageProvider } from '../core/storage.js';
import {
  invalidArgument,
  materializeTemplateSource,
  prepareTemplateSource,
  type PreparedAsset,
} from './render.js';
import type { TemplateSource } from './schemas.js';

/**
 * What `describe()` takes: a template source on its own, or an object naming
 * it with the template's `type` — `'mogrt'` (the default) or `'aep'` — and,
 * for an After Effects project, the composition to describe. The source
 * takes every form a render spec's `source` does: an http(s) URL is used as
 * it is, and a file path, a `file:` URL, a `Buffer` or a `Readable` is
 * uploaded through the client's storage once the job holds its pool slot.
 *
 * @example
 * ```ts
 * await describe('https://example.com/capsule.mogrt?sig=…');
 * await describe('./capsule.mogrt'); // uploaded through storage
 * await describe({ source: { url: capsuleUrl } });
 * await describe({ source: zipUrl, type: 'aep', compName: 'Main' });
 * ```
 */
export type DescribeInput =
  | TemplateSource
  | {
      /** The template: a `.mogrt`, or for `type: 'aep'` a `.zip` holding one `.aep` project and its assets. */
      source: TemplateSource;
      /** The template's kind. Defaults to `'mogrt'`. */
      type?: 'mogrt' | 'aep';
      /** The composition to describe — required when `type` is `'aep'`, unused for a `.mogrt`. */
      compName?: string;
    };

/** One editable control on a template, as describe reports it. */
export interface TemplateControl {
  /** The control's ID — what a render's `variables[].variableId` binds to, e.g. `'0_0_media'`. */
  variableId: string;
  /** The control's kind, e.g. `'media'`. */
  type: string;
  /** The control's display name in the template. */
  label?: string;
  /** The frame size of a media control's slot, in pixels. */
  size?: { width: number; height: number };
  /** The `scale` values a media control accepts, e.g. `'fit_to_frame'`. */
  possibleScaleValues?: string[];
  /** Which properties a render can set on the control, e.g. `'asset'` and `'scale'`. */
  editableProperties?: string[];
  /** The control's default value. */
  defaultData?: unknown;
}

/** A font a template uses, as describe reports it. */
export interface TemplateFont {
  /** The font's PostScript name. */
  name: string;
  /** Whether the font must be supplied with a render because the service does not have it. */
  uploadRequired?: boolean;
}

/** What a finished describe job resolves with: the template's editable controls and its fonts. */
export interface TemplateDescription {
  /** Every editable control, across every element of the template. */
  controls: TemplateControl[];
  /** Every font the template uses. */
  fonts: TemplateFont[];
}

/** @internal The wire body of `POST /v1/templates/describe`. */
export interface DescribeBody {
  source: { url: string };
  type?: 'mogrt' | 'aep';
  compName?: string;
}

/** @internal A describe request validated and its source read, before any storage call. */
export interface PreparedDescribe {
  readonly source: PreparedAsset;
  readonly type?: 'mogrt' | 'aep';
  readonly compName?: string;
}

/**
 * @internal Validates a {@link DescribeInput} and reads whether its source
 * needs uploading, by the rule a render spec's `source` follows — checking
 * that storage is there when it does. Consults only the local filesystem;
 * performs no remote call.
 *
 * @throws {@link AudioVideoError} `invalid_argument` for a source a render
 *   spec would refuse, an unknown `type`, `type: 'aep'` without a
 *   `compName`, or a source to upload when no storage is configured.
 */
export async function prepareDescribe(
  input: DescribeInput,
  storage: StorageProvider | undefined,
): Promise<PreparedDescribe> {
  const named =
    isRecord(input) && 'source' in input && !Buffer.isBuffer(input) && !isReadable(input);
  const request = named ? input : { source: input };
  const type = request.type === 'mogrt' || request.type === 'aep' ? request.type : undefined;
  if (request.type !== undefined && type === undefined) {
    throw invalidArgument("describe: type must be 'mogrt' or 'aep'.");
  }
  const compName = typeof request.compName === 'string' ? request.compName : undefined;
  if (request.compName !== undefined && !compName) {
    throw invalidArgument('describe: compName must be a non-empty string when provided.');
  }
  if (type === 'aep' && compName === undefined) {
    throw invalidArgument("describe: type 'aep' requires a compName naming the composition.");
  }
  const source = await prepareTemplateSource(request.source);
  if ('stage' in source && storage === undefined) throw noStorage('source');
  return {
    source,
    ...(type !== undefined ? { type } : {}),
    ...(compName !== undefined ? { compName } : {}),
  };
}

/**
 * @internal The wire body of a prepared describe, uploading its source first
 * when it needs that. Runs once the job holds its pool slot, just before the
 * submit; `signal` aborts the upload.
 *
 * @throws {@link AudioVideoError} `storage_failed` when the upload fails.
 */
export async function materializeDescribe(
  prepared: PreparedDescribe,
  storage: StorageProvider | undefined,
  signal: AbortSignal,
): Promise<DescribeBody> {
  const url = await materializeTemplateSource(prepared.source, storage, signal);
  return {
    source: { url },
    ...(prepared.type !== undefined ? { type: prepared.type } : {}),
    ...(prepared.compName !== undefined ? { compName: prepared.compName } : {}),
  };
}

/**
 * @internal The {@link TemplateDescription} a terminal describe status body
 * carries: the service nests controls under `output.elements[].controls[]`
 * and fonts under `output.fonts[]`. Entries without a string `variableId`
 * (controls) or `name` (fonts) are skipped.
 */
export function describeResult(terminal: JobStatusLike): TemplateDescription {
  const output = (terminal as { output?: unknown }).output;
  const elements = isRecord(output) && Array.isArray(output.elements) ? output.elements : [];
  const controls = elements.flatMap((element: unknown) =>
    isRecord(element) && Array.isArray(element.controls)
      ? element.controls.filter(
          (control: unknown): control is TemplateControl =>
            isRecord(control) && typeof control.variableId === 'string',
        )
      : [],
  );
  const fonts =
    isRecord(output) && Array.isArray(output.fonts)
      ? output.fonts.filter(
          (font: unknown): font is TemplateFont => isRecord(font) && typeof font.name === 'string',
        )
      : [];
  return { controls, fonts };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
