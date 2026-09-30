/**
 * Transforms a friendly {@link RenderSpec} into the wire body DGR's
 * `POST /v1/templates/render` actually expects.
 */

import * as z from 'zod';
import { RenderSpecSchema, type RenderSpec } from './schemas.js';
import type { RenderBodyOutput, RenderBodyPresetRef, RenderBodyWire } from './types.js';

/**
 * Validates `spec` against {@link RenderSpecSchema} and, once valid, transforms it
 * into the DGR wire body. Bakes in the gotchas verified against the live API:
 *
 * - `destination` is wrapped as `{ url }` — the published API spec types it as a
 *   bare string, which the real API rejects.
 * - Every preset reference is wrapped as `{ source: { presetId } }` or
 *   `{ source: { url } }` — a bare `{ presetId }` is rejected with a
 *   `422 validation_error`.
 * - `variationIndex` defaults to `0` when omitted.
 * - `fileName` is left off the output entirely when absent, rather than sent as
 *   `undefined`.
 * - `presetIndex` passes through unchanged — it is already a 0-based index into
 *   `presets[]`.
 *
 * Validation runs first: a spec that fails {@link RenderSpecSchema} throws a zod
 * `ZodError` before any transform is attempted, so a caller never gets a
 * partially-built wire body for invalid input. So does a variable whose
 * `assetIndex` points past the end of `assets` — the API would otherwise be
 * sent a body referencing an asset that does not exist.
 *
 * @param spec - The friendly render input (strings for URLs/paths).
 * @returns The wire body, ready to be sent as the JSON body of
 *   `POST /v1/templates/render`.
 * @throws A zod `ZodError` when `spec` fails validation against
 *   {@link RenderSpecSchema}, or names an `assetIndex` it has no asset for.
 *
 * @example
 * ```ts
 * const body = buildRenderBody({
 *   source: 'https://example.com/capsule.mogrt?sig=…',
 *   presets: [{ presetId: 'ffs_video_api_prores' }],
 *   outputs: [{ presetIndex: 0, destination: 'https://example.com/out.mov?sig=…' }],
 * });
 * // body.presets[0] -> { source: { presetId: 'ffs_video_api_prores' } }
 * // body.outputs[0].destination -> { url: 'https://example.com/out.mov?sig=…' }
 * ```
 */
export function buildRenderBody(spec: RenderSpec): RenderBodyWire {
  const parsed = RenderSpecSchema.parse(spec);
  checkAssetIndices(parsed);

  const presets: RenderBodyPresetRef[] = parsed.presets.map((preset) =>
    'presetId' in preset
      ? { source: { presetId: preset.presetId } }
      : { source: { url: preset.url } },
  );

  const outputs: RenderBodyOutput[] = parsed.outputs.map((output) => ({
    variationIndex: output.variationIndex ?? 0,
    presetIndex: output.presetIndex,
    ...(output.fileName ? { fileName: output.fileName } : {}),
    destination: { url: output.destination },
  }));

  return {
    source: { url: parsed.source },
    presets,
    ...(parsed.assets && parsed.assets.length > 0
      ? { assets: parsed.assets.map((url) => ({ source: { url } })) }
      : {}),
    ...(parsed.variations && parsed.variations.length > 0 ? { variations: parsed.variations } : {}),
    outputs,
  };
}

/**
 * @internal Throws a `ZodError` naming every variable whose `assetIndex`
 * points past the end of `spec.assets`.
 */
export function checkAssetIndices(spec: {
  assets?: readonly unknown[];
  variations?: RenderSpec['variations'];
}): void {
  const assetCount = spec.assets?.length ?? 0;
  const issues: z.core.$ZodIssue[] = [];
  spec.variations?.forEach((variation, v) => {
    variation.variables.forEach((variable, i) => {
      const { assetIndex } = variable;
      if (assetIndex === undefined || assetIndex < assetCount) return;
      issues.push({
        code: 'custom',
        path: ['variations', v, 'variables', i, 'assetIndex'],
        message: `assetIndex is ${assetIndex}, but the spec has ${assetCount} asset${assetCount === 1 ? '' : 's'}`,
        input: assetIndex,
      });
    });
  });
  if (issues.length > 0) throw new z.ZodError(issues);
}
