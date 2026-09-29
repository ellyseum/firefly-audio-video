/**
 * The named preset catalog: one entry per {@link PresetName}, each declaring
 * whether it passes through to a DGR-native `presetId` or is rendered from a
 * generated `.epr`. `Preset`'s named accessors, the `presets` object, `toPreset`
 * and `resolvePreset` all read this one map.
 */

import type { EncodeConfig, PresetName, ResolutionString } from '../dgr/schemas.js';

/**
 * A catalog entry.
 *
 * - `passthrough` — resolves to DGR's own `presetId`; `config` describes what
 *   that native preset produces, so chained modifiers have a base to build on
 *   and a config equal to it resolves back to the native preset.
 * - `epr` — DGR has no native preset for it; `config` is rendered to an `.epr`
 *   and staged at render time.
 */
export type NamedEntry =
  | { readonly kind: 'passthrough'; readonly presetId: string; readonly config: EncodeConfig }
  | { readonly kind: 'epr'; readonly config: EncodeConfig };

/**
 * The frame sizes of DGR's native H.264 ladder, keyed by aspect ratio — what
 * `resize('9:16')` and friends resolve to.
 */
export const ASPECT_RESOLUTIONS = {
  '16:9': '1920x1080',
  '1:1': '1080x1080',
  '9:16': '1080x1920',
  '2:3': '1080x1620',
  '4:5': '1080x1350',
} as const satisfies Record<string, ResolutionString>;

/** An aspect ratio on DGR's native H.264 ladder; see {@link ASPECT_RESOLUTIONS}. */
export type AspectRatio = keyof typeof ASPECT_RESOLUTIONS;

/** Every catalog entry, keyed by name. */
export const NAMED: Readonly<Record<PresetName, NamedEntry>> = {
  h264Land1080pHq: {
    kind: 'passthrough',
    presetId: 'ffs_video_api_land_1080p_hq',
    config: { codec: 'h264', resolution: '1920x1080', mode: 'hq' },
  },
  h264Land1080pLq: {
    kind: 'passthrough',
    presetId: 'ffs_video_api_land_1080p_lq',
    config: { codec: 'h264', resolution: '1920x1080', mode: 'lq' },
  },
  h264Land1080p2Pass: {
    kind: 'passthrough',
    presetId: 'ffs_video_api_land_1080p_2_pass',
    config: { codec: 'h264', resolution: '1920x1080', mode: '2pass' },
  },
  h264Square1080pHq: {
    kind: 'passthrough',
    presetId: 'ffs_video_api_square_1080p_hq',
    config: { codec: 'h264', resolution: '1080x1080', mode: 'hq' },
  },
  h264Square1080pLq: {
    kind: 'passthrough',
    presetId: 'ffs_video_api_square_1080p_lq',
    config: { codec: 'h264', resolution: '1080x1080', mode: 'lq' },
  },
  h264Square1080p2Pass: {
    kind: 'passthrough',
    presetId: 'ffs_video_api_square_1080p_2_pass',
    config: { codec: 'h264', resolution: '1080x1080', mode: '2pass' },
  },
  h264Vert1920pHq: {
    kind: 'passthrough',
    presetId: 'ffs_video_api_vert_1920p_hq',
    config: { codec: 'h264', resolution: '1080x1920', mode: 'hq' },
  },
  h264Vert1920pLq: {
    kind: 'passthrough',
    presetId: 'ffs_video_api_vert_1920p_lq',
    config: { codec: 'h264', resolution: '1080x1920', mode: 'lq' },
  },
  h264Vert1920p2Pass: {
    kind: 'passthrough',
    presetId: 'ffs_video_api_vert_1920p_2_pass',
    config: { codec: 'h264', resolution: '1080x1920', mode: '2pass' },
  },
  h264Portrait1620pHq: {
    kind: 'passthrough',
    presetId: 'ffs_video_api_portrait_2x3_1620p_hq',
    config: { codec: 'h264', resolution: '1080x1620', mode: 'hq' },
  },
  h264Portrait1620pLq: {
    kind: 'passthrough',
    presetId: 'ffs_video_api_portrait_2x3_1620p_lq',
    config: { codec: 'h264', resolution: '1080x1620', mode: 'lq' },
  },
  h264Portrait1620p2Pass: {
    kind: 'passthrough',
    presetId: 'ffs_video_api_portrait_2x3_1620p_2_pass',
    config: { codec: 'h264', resolution: '1080x1620', mode: '2pass' },
  },
  h264Portrait1350pHq: {
    kind: 'passthrough',
    presetId: 'ffs_video_api_portrait_4x5_1350p_hq',
    config: { codec: 'h264', resolution: '1080x1350', mode: 'hq' },
  },
  h264Portrait1350pLq: {
    kind: 'passthrough',
    presetId: 'ffs_video_api_portrait_4x5_1350p_lq',
    config: { codec: 'h264', resolution: '1080x1350', mode: 'lq' },
  },
  h264Portrait1350p2Pass: {
    kind: 'passthrough',
    presetId: 'ffs_video_api_portrait_4x5_1350p_2_pass',
    config: { codec: 'h264', resolution: '1080x1350', mode: '2pass' },
  },
  /** ProRes 4444 with alpha at the source's frame size and rate. */
  prores: {
    kind: 'passthrough',
    presetId: 'ffs_video_api_prores',
    config: { codec: 'prores4444', alpha: true, matchSource: true },
  },
  /** ProRes 4444 XQ (`ap4x`) with alpha at the source's frame size and rate. */
  prores4444xq: {
    kind: 'epr',
    config: { codec: 'prores4444xq', alpha: true, matchSource: true },
  },
  /** HEVC Main10 (`hvc1`), 4:2:0, 1920x1080, frame rate from the source. */
  hevc1080p10bit: {
    kind: 'epr',
    config: { codec: 'hevc', bitDepth: 10, chroma: '420', resolution: '1920x1080' },
  },
  /** HEVC Main10 (`hvc1`), 4:2:0, 3840x2160, frame rate from the source. */
  hevc4k10bit: {
    kind: 'epr',
    config: { codec: 'hevc', bitDepth: 10, chroma: '420', resolution: '3840x2160' },
  },
};

/** The catalog name of a DGR-native `presetId`, or `undefined` when it is not one of the sixteen. */
export function nameForPresetId(presetId: string): PresetName | undefined {
  for (const [name, entry] of Object.entries(NAMED) as [PresetName, NamedEntry][]) {
    if (entry.kind === 'passthrough' && entry.presetId === presetId) return name;
  }
  return undefined;
}
