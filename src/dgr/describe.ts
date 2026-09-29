/**
 * The describe capability's input and result shapes: what `describe()` takes,
 * the wire body `POST /v1/templates/describe` expects, and the
 * {@link TemplateDescription} a finished describe job resolves with.
 */

import type { JobStatusLike } from '../core/job.js';
import { invalidArgument, templateUrl, type TemplateSource } from './render.js';

/**
 * What `describe()` takes: a template source on its own, or an object naming
 * it with the template's `type` — `'mogrt'` (the default) or `'aep'` — and,
 * for an After Effects project, the composition to describe.
 *
 * @example
 * ```ts
 * await describe('https://example.com/capsule.mogrt?sig=…');
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

/**
 * @internal Normalizes a {@link DescribeInput} to its wire body.
 *
 * @throws {@link AudioVideoError} `invalid_argument` for a missing template
 *   URL, an unknown `type`, or `type: 'aep'` without a `compName`.
 */
export function describeBody(input: DescribeInput): DescribeBody {
  if (!isRecord(input) || !('source' in input)) {
    return { source: { url: templateUrl(input, 'The describe source') } };
  }
  const url = templateUrl(input.source, 'The describe source');
  const type = input.type === 'mogrt' || input.type === 'aep' ? input.type : undefined;
  if (input.type !== undefined && type === undefined) {
    throw invalidArgument("describe: type must be 'mogrt' or 'aep'.");
  }
  const compName = typeof input.compName === 'string' ? input.compName : undefined;
  if (input.compName !== undefined && !compName) {
    throw invalidArgument('describe: compName must be a non-empty string when provided.');
  }
  if (type === 'aep' && compName === undefined) {
    throw invalidArgument("describe: type 'aep' requires a compName naming the composition.");
  }
  return {
    source: { url },
    ...(type !== undefined ? { type } : {}),
    ...(compName !== undefined ? { compName } : {}),
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
