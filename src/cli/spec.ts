/**
 * The two ways `render` builds a spec: `--spec <file>` reads one from disk,
 * or `--template` with `--preset`/`--encode` assembles a single-output one
 * from flags. Neither validates the render spec's shape — that is
 * `client.render()`'s own job, against the real schema — so both return
 * `unknown` rather than claim a type this module never checked.
 */

import { readFileSync } from 'node:fs';
import { invalidArgument } from './errors.js';

/** Reads and JSON-parses a render spec file. Performs no schema validation. */
export function readSpecFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw invalidArgument(`Could not read the spec file at ${JSON.stringify(path)}.`, error);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw invalidArgument(`The spec file at ${JSON.stringify(path)} is not valid JSON.`, error);
  }
}

/** `render`'s own flags, exactly as commander reports them. */
export interface RenderFlags {
  template?: string;
  preset?: string;
  encode?: string;
}

/**
 * A one-output render spec from `render`'s own flags: `--template` names the
 * source, and exactly one of `--preset` (a catalog name, a native presetId,
 * or an `.epr` path — passed through as a string) or `--encode` (a JSON
 * encode config) names the preset. The output carries no destination, so
 * the client's storage allocates one.
 *
 * @throws {@link AudioVideoError} `invalid_argument` when `--template` is
 *   missing, `--preset` and `--encode` are both given or both omitted, or
 *   `--encode` is not a JSON object.
 */
export function buildRenderRequestFromFlags(flags: RenderFlags): Record<string, unknown> {
  if (flags.template === undefined || flags.template.trim() === '') {
    throw invalidArgument('render needs --spec <file>, or --template with --preset or --encode.');
  }
  if (flags.preset !== undefined && flags.encode !== undefined) {
    throw invalidArgument('render takes --preset or --encode, not both.');
  }
  if (flags.preset === undefined && flags.encode === undefined) {
    throw invalidArgument(
      'render needs a preset: pass --preset <name|native id|.epr path> or --encode <json>.',
    );
  }
  const presetInput =
    flags.preset !== undefined ? flags.preset : parseEncodeJson(flags.encode as string);
  return {
    source: flags.template,
    presets: [presetInput],
    outputs: [{ presetIndex: 0 }],
  };
}

function parseEncodeJson(json: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw invalidArgument('--encode must be valid JSON.', error);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidArgument('--encode must be a JSON object, e.g. \'{"codec":"hevc"}\'.');
  }
  return parsed as Record<string, unknown>;
}
