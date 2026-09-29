/**
 * Every name in the preset catalog, in one dependency-free module: the zod schema
 * (../dgr/schemas.ts) builds its enum from this list and the catalog
 * (./catalog.ts) is typed against it, so neither has to import the other.
 */

/**
 * The catalog's preset names. The first fifteen name DGR's native H.264 presets
 * (orientation + height + rate tier), `prores` names DGR's native ProRes 4444
 * preset, and the rest are generated-`.epr` presets for codecs DGR has no native
 * preset for.
 */
export const PRESET_NAMES = [
  'h264Land1080pHq',
  'h264Land1080pLq',
  'h264Land1080p2Pass',
  'h264Square1080pHq',
  'h264Square1080pLq',
  'h264Square1080p2Pass',
  'h264Vert1920pHq',
  'h264Vert1920pLq',
  'h264Vert1920p2Pass',
  'h264Portrait1620pHq',
  'h264Portrait1620pLq',
  'h264Portrait1620p2Pass',
  'h264Portrait1350pHq',
  'h264Portrait1350pLq',
  'h264Portrait1350p2Pass',
  'prores',
  'prores4444xq',
  'hevc1080p10bit',
  'hevc4k10bit',
] as const;
