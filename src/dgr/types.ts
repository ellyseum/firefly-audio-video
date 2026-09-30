/**
 * Hand-authored wire types for the DGR (Dynamic Graphics Render) render request —
 * the body actually sent to `audio-video-api.adobe.io`, as verified against the
 * live API. These are deliberately NOT derived from zod: they describe a fixed,
 * external wire contract rather than a boundary this SDK validates its own input
 * against, and — unlike the public OpenAPI spec, which types `destination` as a
 * bare string — they encode the gotchas the real API actually requires. Internal
 * only: `buildRenderBody` produces a {@link RenderBodyWire}. None of this module
 * is re-exported from the package's public entry point.
 */

import type { RenderVariable } from './schemas.js';

/**
 * A render preset reference in wire form: a DGR-native `presetId`, or a presigned
 * URL to a staged `.epr` — both wrapped in the `{ source: { … } }` envelope every
 * asset reference uses. A bare `{ presetId }` (unwrapped) is rejected by the real
 * API with a `422 validation_error`.
 */
export type RenderBodyPresetRef = { source: { presetId: string } } | { source: { url: string } };

/**
 * One deliverable in wire form. `destination` MUST be an object — the published API
 * spec types it as a bare string, which is wrong and will be rejected by the real
 * API.
 */
export interface RenderBodyOutput {
  /** 0-based index into the render's `variations[]`; defaults to `0` when only one variation exists. */
  variationIndex: number;
  /** 0-based index into the render body's `presets[]`. */
  presetIndex: number;
  /** Cosmetic only — the preset dictates the real container/extension, not this value. */
  fileName?: string;
  /** A presigned write URL, wrapped in the object form the wire format requires. */
  destination: { url: string };
}

/**
 * The wire body for `POST /v1/templates/render`, as produced by `buildRenderBody`
 * from a friendly {@link RenderSpec} (./schemas.ts). A successful submit returns
 * `202 { jobId, statusUrl }`; poll `statusUrl` until the job is terminal.
 */
export interface RenderBodyWire {
  source: { url: string };
  presets: RenderBodyPresetRef[];
  assets?: { source: { url: string } }[];
  variations?: { variables: RenderVariable[] }[];
  outputs: RenderBodyOutput[];
}
