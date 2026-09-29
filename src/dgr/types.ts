/**
 * Hand-authored wire and response types for the DGR (Dynamic Graphics Render) API —
 * the shapes actually sent to and received from `audio-video-api.adobe.io`, as
 * byte-verified against the live API. These are
 * deliberately NOT derived from zod: they describe a fixed, external wire contract
 * rather than a boundary this SDK validates its own input against, and — unlike the
 * public OpenAPI spec, which types `destination` as a bare string — they encode the
 * gotchas the real API actually requires. Internal only: `buildRenderBody` produces
 * a {@link RenderBodyWire}, and the HTTP client (a later task) will produce
 * {@link JobStatusResponse} / {@link Controls} / {@link PresetSummary} from parsed
 * JSON responses. None of this module is re-exported from the package's public
 * entry point.
 */

import type { RenderVariable } from './schemas.js';

/**
 * A render preset reference in wire form: either a presigned URL to a staged `.epr`
 * (wrapped in the `{ source: { url } }` envelope every asset reference uses), or a
 * DGR-native `presetId` passed through unchanged.
 */
export type RenderBodyPresetRef = { source: { url: string } } | { presetId: string };

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
 * `202 { jobId, statusUrl }`; poll `statusUrl` for a {@link JobStatusResponse} until
 * terminal.
 */
export interface RenderBodyWire {
  source: { url: string };
  presets: RenderBodyPresetRef[];
  assets?: { source: { url: string } }[];
  variations?: { variables: RenderVariable[] }[];
  outputs: RenderBodyOutput[];
}

/**
 * One item of a job's `outputs[]` on the status response — the terminal state of a
 * single deliverable. Item-level `errors` can appear here while the job's own
 * `status` still reads `"running"`, so terminal detection must inspect
 * this array rather than trusting `status` alone.
 *
 * `startedDate` and `completedDate` are raw wire timestamps, deliberately typed as
 * `string` rather than parsed: they may carry more than millisecond precision
 * (`completedDate` at nanosecond precision, while `createdDate` on
 * {@link JobStatusResponse} is millisecond precision), so a consumer should
 * truncate the fraction to three digits before parsing for a result that does not
 * depend on the host engine's date parser — that parse belongs to whatever
 * computes timing, not here.
 */
export interface JobItem {
  startedDate?: string;
  completedDate?: string;
  errors?: unknown[];
  destination?: { url: string };
}

/**
 * The response body for `GET /v1/status/{jobId}` (and the terminal state a
 * submit's `statusUrl` resolves to). `errors` at the job level and `errors` on each
 * {@link JobItem} are both meaningful for terminal detection — a job can be terminal
 * with per-item failures while `status` itself still reads `"running"`.
 *
 * @example
 * ```ts
 * const status: JobStatusResponse = {
 *   jobId: 'abc123',
 *   status: 'running',
 *   createdDate: '2026-09-29T12:00:00.000Z',
 *   totalJobItems: 1,
 *   outputs: [{ startedDate: '2026-09-29T12:00:01.000Z' }],
 * };
 * ```
 */
export interface JobStatusResponse {
  jobId: string;
  /** Not an exhaustive enum — only `"running"` is confirmed in the proven substrate. */
  status: string;
  /** Raw wire timestamp, millisecond precision (contrast {@link JobItem.completedDate}). */
  createdDate?: string;
  totalJobItems?: number;
  outputs?: JobItem[];
  errors?: unknown[];
}

/**
 * One entry of `GET /v1/presets` — DGR's catalog of native named presets. Only `id`
 * is verified against the proven substrate; the remaining fields the real endpoint
 * returns are unconfirmed, so this stays deliberately open rather than asserting an
 * unverified shape.
 */
export interface PresetSummary {
  id: string;
  [key: string]: unknown;
}

/**
 * One editable control on a template, as reported by the describe endpoint
 * (`POST /v1/templates/describe`, polled to completion).
 */
export interface ControlVariable {
  variableId: string;
  /** Not an exhaustive enum — the set of control types is established by Task 9's preset/`.epr` work. */
  type: string;
}

/** The resolved result of `POST /v1/templates/describe`: every editable control on a template. */
export interface Controls {
  variables: ControlVariable[];
}
