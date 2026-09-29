/**
 * The internal `.epr` serializer. {@link toEpr} renders an {@link EncodeConfig}
 * as an Adobe Media Encoder export preset (`<PremiereData Version="3">` XML) by
 * patching a copy of an embedded AME system preset; {@link parseEprHeadline}
 * reads the headline fields back out of any `.epr`. Not public API: the SDK's
 * surface is JSON, and this XML only ever travels to staging.
 */

import { createHash } from 'node:crypto';
import { AudioVideoError } from '../core/errors.js';
import { EncodeConfigSchema, MODES, type BitDepth, type EncodeConfig } from '../dgr/schemas.js';
import { ASPECT_RESOLUTIONS } from './catalog.js';
import {
  CODEC_TRAITS,
  bitrateBps,
  frameRateOfTicks,
  frameSizeOf,
  invalidPreset,
  normalizeFrameRate,
  parseOrThrow,
  quoted,
  ticksPerFrame,
  type CodecTraits,
  type FrameSize,
} from './codecs.js';
import { HEVC_BASE_EPR } from './epr-templates/hevc.js';
import { QUICKTIME_BASE_EPR } from './epr-templates/quicktime.js';

/**
 * AME identifies an exporter by `ExporterClassID` + `ExporterFileType`. Written
 * as `%08X_%08X` that pair is also the exporter's system-preset folder name —
 * which is how AME files a preset under a codec family.
 */
export const EXPORTER_FOLDERS = {
  hevc: '4A454646_48455643',
  quicktime: '3F3F3F3F_4D6F6F56',
  h264: '4E49434B_48323634',
} as const;

/** An `ADBEVideoMatchSource` payload: base64 data plus the checksum AME stores beside it. */
interface MatchSourcePayload {
  readonly data: string;
  readonly checksum: string;
}

/**
 * `ADBEVideoMatchSource` payloads. The data is a little-endian bitmask of the
 * properties that follow the source — bit 0 frame size, bit 2 frame rate — and
 * each payload is copied, checksum included, from an AME system preset that
 * ships it. The checksum algorithm is AME-internal, so no other payload is ever
 * written.
 */
const MATCH_SOURCE = {
  /** Nothing follows the source (AME's "8K UHD" HEVC preset). */
  none: { data: 'AAAAAA==', checksum: '2374864269' },
  /** The frame rate follows the source (AME's "HD 1080p" HEVC preset). */
  hevcFrameRate: { data: 'BAAAAA==', checksum: '2492304781' },
  /** Frame size, frame rate, field order, pixel aspect, profile and level follow the source (AME's "Match Source - High Bitrate" HEVC preset). */
  hevcAll: { data: 'fwAAAA==', checksum: '546147725' },
  /** Frame rate and pixel aspect follow the source (AME's "Adobe Stock" ProRes presets). */
  quicktimeFrameRate: { data: 'DAAAAA==', checksum: '2794294669' },
  /** Frame size, frame rate, field order and pixel aspect follow the source (AME's ProRes presets). */
  quicktimeAll: { data: 'HQAAAA==', checksum: '1418562957' },
} as const satisfies Record<string, MatchSourcePayload>;

/** HEVC parameters AME marks disabled while the source drives them (its "Match Source - High Bitrate" preset). */
const HEVC_SOURCE_DRIVEN = [
  'ADBEVideoWidth',
  'ADBEVideoHeight',
  'ADBEVideoAspect',
  'ADBEVideoMPEGProfile',
  'ADBEVideoMPEGProfileLevel',
] as const;

/** An HEVC level as AME stores it (`41` = level 4.1), with its Main-tier limits. */
interface HevcLevel {
  readonly level: number;
  /** Maximum luma picture size, in samples. */
  readonly maxLumaPs: number;
  /** Maximum luma sample rate, in samples per second. */
  readonly maxLumaSr: number;
  /** Maximum bitrate, in megabits per second. */
  readonly maxMbps: number;
}

/**
 * ITU-T H.265 Main-tier level limits, restricted to the levels AME's own HEVC
 * presets use. A level also caps each picture dimension at √(8 × maxLumaPs).
 */
const HEVC_LEVELS: readonly HevcLevel[] = [
  { level: 30, maxLumaPs: 552_960, maxLumaSr: 16_588_800, maxMbps: 6 },
  { level: 31, maxLumaPs: 983_040, maxLumaSr: 33_177_600, maxMbps: 10 },
  { level: 41, maxLumaPs: 2_228_224, maxLumaSr: 133_693_440, maxMbps: 20 },
  { level: 51, maxLumaPs: 8_912_896, maxLumaSr: 534_773_760, maxMbps: 40 },
  { level: 52, maxLumaPs: 8_912_896, maxLumaSr: 1_069_547_520, maxMbps: 60 },
  { level: 62, maxLumaPs: 35_651_584, maxLumaSr: 4_278_190_080, maxMbps: 240 },
];

/** The {@link HevcLevel} named `value` (`41` = level 4.1) in {@link HEVC_LEVELS}. */
function levelOf(value: number): HevcLevel {
  return HEVC_LEVELS.find((candidate) => candidate.level === value)!;
}

/**
 * Default HEVC target/maximum bitrate (Mbps) and level by frame size, as AME's
 * own HEVC presets set them: SD 480p, HD 720p, HD 1080p, 4K UHD, 8K UHD. A
 * source-driven-rate default (no fixed frame rate) takes the row's level as
 * AME ships it; a fixed frame rate, or a custom bitrate, instead computes the
 * lowest H.265 Main-tier level admitting the request (see {@link hevcRates}).
 */
const HEVC_DEFAULT_RATES: readonly {
  maxPixels: number;
  target: number;
  max: number;
  level: HevcLevel;
}[] = [
  { maxPixels: 854 * 480, target: 1.3, max: 1.8, level: levelOf(30) },
  { maxPixels: 1280 * 720, target: 4, max: 6, level: levelOf(31) },
  { maxPixels: 1920 * 1080, target: 16, max: 20, level: levelOf(41) },
  { maxPixels: 3840 * 2160, target: 35, max: 40, level: levelOf(52) },
  { maxPixels: Number.POSITIVE_INFINITY, target: 120, max: 160, level: levelOf(62) },
];

/** The frame size AME stores in an HEVC preset whose frame size follows the source. */
const HEVC_TEMPLATE_SIZE: FrameSize = { width: 1920, height: 1080 };

/** HEVC's peak-to-target bitrate ratio (AME's "HD 1080p" preset: 16 → 20 Mbps). */
const HEVC_PEAK_RATIO = 1.25;
const HEVC_MIN_MBPS = 0.192;
const HEVC_MAX_MBPS = 240;
const MIN_FPS = 1;
const MAX_FPS = 240;

/** Everything {@link toEpr} derives from a config before it touches the template. */
interface EprPlan {
  readonly traits: CodecTraits & { readonly family: 'hevc' | 'quicktime'; readonly fourcc: string };
  /** The fixed frame size, or `undefined` when the frame size follows the source. */
  readonly size?: FrameSize;
  /** The fixed frame rate (fps, three decimals), or `undefined` when it follows the source. */
  readonly fps?: number;
  /** The encoded bit depth, or `undefined` when HEVC takes its profile from the source. */
  readonly bitDepth?: BitDepth;
  readonly alpha: boolean;
  /** HEVC rate control, or `undefined` to keep the template's. */
  readonly rates?: { readonly level: HevcLevel; readonly target: number; readonly max: number };
}

/**
 * Renders `config` as `.epr` XML: the codec family's embedded AME system preset
 * with the fields the config varies patched in. Pure and deterministic — the
 * same config, however it is spelled, always yields byte-identical XML with
 * CRLF line endings, as AME writes them.
 *
 * | family | patched fields |
 * |---|---|
 * | HEVC | frame size or match-source, frame rate, profile (8/10-bit), level, target/maximum bitrate |
 * | ProRes | codec (`ap4h` / `ap4x`), frame size or match-source, frame rate, alpha |
 *
 * Every generated preset also gets its own name, description and `PresetID`.
 *
 * @throws {@link AudioVideoError} — `code: 'invalid_preset'` — when the config
 *   fails schema validation, or names a combination its codec cannot produce
 *   (the message says what the codec supports).
 */
export function toEpr(config: EncodeConfig): string {
  const parsed = parseOrThrow(EncodeConfigSchema, config, 'preset config');
  const plan = planEpr(parsed);
  const body = plan.traits.family === 'hevc' ? hevcXml(plan) : quicktimeXml(plan);
  const xml = withMetadata(body, plan, presetIdFor(body));
  return xml.replace(/\n/g, '\r\n');
}

/** DGR's native H.264 frame sizes — the same ladder `resize()` maps aspect ratios onto. */
const H264_SIZES: readonly string[] = Object.values(ASPECT_RESOLUTIONS);

/** Names what H.264 supports, then its native ladder — kept well under 500 characters. */
const H264_LADDER = `H.264 renders only through DGR's native presets: resolution one of ${H264_SIZES.join(', ')}; mode one of ${MODES.map((mode) => `'${mode}'`).join(', ')}; always 8-bit 4:2:0 with no bitrate, frameRate, alpha or color.`;

/** Why `config` matches no native H.264 preset, then the native ladder. */
function h264Mismatch(config: EncodeConfig, traits: CodecTraits): string {
  return `${h264Deviation(config, traits)} ${H264_LADDER}`;
}

/** The one field that stops `config` matching a native H.264 preset. */
function h264Deviation(config: EncodeConfig, traits: CodecTraits): string {
  if (config.alpha === true) return 'alpha is not available for H.264.';
  if (config.bitrate !== undefined) {
    return "bitrate is not settable for H.264; remove .bitrate() or choose codec 'hevc'.";
  }
  if (config.frameRate !== undefined) {
    return "frameRate is not settable for H.264; remove .with({ frameRate }) or choose codec 'hevc'.";
  }
  if (config.color !== undefined) {
    return "color is not settable for H.264; remove .with({ color }) or choose codec 'hevc'.";
  }
  if (config.chroma !== undefined && config.chroma !== traits.chroma) {
    return `H.264 encodes chroma '${traits.chroma}' only; got '${config.chroma}'.`;
  }
  if (config.bitDepth !== undefined && config.bitDepth !== traits.bitDepths[0]) {
    return `H.264 encodes bitDepth ${traits.bitDepths[0]} only; got ${config.bitDepth}.`;
  }
  if (config.matchSource !== undefined) {
    return 'matchSource is not settable for H.264; set resolution instead.';
  }
  if (config.resolution === undefined) {
    return `resolution is required: one of ${H264_SIZES.join(', ')}.`;
  }
  const { width, height } = frameSizeOf(config.resolution);
  const size = `${width}x${height}`;
  if (!H264_SIZES.includes(size)) return `size ${size} is not a native H.264 size.`;
  if (config.mode === undefined) return "mode is required: 'hq' | 'lq' | '2pass'.";
  return 'this config already matches a native H.264 preset; call resolvePreset(), not toEpr(), for H.264.';
}

/** Validates `config` against what its codec can produce and derives the {@link EprPlan}. */
function planEpr(config: EncodeConfig): EprPlan {
  const traits = CODEC_TRAITS[config.codec];
  const { family, fourcc } = traits;
  if (family === undefined || fourcc === undefined) {
    throw invalidPreset(h264Mismatch(config, traits));
  }
  const codec = `codec '${config.codec}'`;

  if (config.mode !== undefined) {
    throw invalidPreset(
      `mode selects one of DGR's native H.264 presets; ${codec} does not take one${traits.bitrate ? ' (set bitrate instead)' : ''}.`,
    );
  }
  if (config.color !== undefined && config.color.toLowerCase() !== 'rec709') {
    throw invalidPreset(
      `color ${quoted(config.color)} is not supported: generated .epr presets encode Rec. 709 ('rec709').`,
    );
  }
  if (config.chroma !== undefined && config.chroma !== traits.chroma) {
    throw invalidPreset(`${codec} encodes chroma '${traits.chroma}' only; got '${config.chroma}'.`);
  }
  if (config.bitDepth !== undefined && !traits.bitDepths.includes(config.bitDepth)) {
    throw invalidPreset(
      `${codec} encodes bitDepth ${traits.bitDepths.join(' or ')}; got ${config.bitDepth}.`,
    );
  }
  if (config.alpha === true && !traits.alpha) {
    throw invalidPreset(
      `${codec} has no alpha channel; alpha needs 'prores4444' or 'prores4444xq'.`,
    );
  }
  if (config.bitrate !== undefined && !traits.bitrate) {
    throw invalidPreset(`${codec} has a fixed data rate per frame size; remove bitrate.`);
  }

  let size: FrameSize | undefined;
  if (config.resolution !== undefined) {
    size = frameSizeOf(config.resolution);
    checkFrameSize(config.codec, size);
  } else if (config.matchSource === false) {
    throw invalidPreset(
      'matchSource: false needs a resolution: there is no other frame size to encode.',
    );
  }

  let fps: number | undefined;
  if (config.frameRate !== undefined) {
    if (size === undefined) {
      throw invalidPreset(
        'frameRate needs a resolution: without one, the frame size and frame rate both follow the source.',
      );
    }
    if (config.frameRate < MIN_FPS || config.frameRate > MAX_FPS) {
      throw invalidPreset(
        `frameRate must be between ${MIN_FPS} and ${MAX_FPS} fps; got ${config.frameRate}.`,
      );
    }
    fps = normalizeFrameRate(config.frameRate);
  }

  if (family === 'hevc' && size === undefined && config.bitDepth !== undefined) {
    throw invalidPreset(
      `${codec} without a resolution takes its profile, and so its bit depth, from the source; set a resolution to fix bitDepth.`,
    );
  }

  const bitDepth =
    family === 'hevc' && size === undefined ? undefined : (config.bitDepth ?? traits.bitDepths[0]);
  const rates = family === 'hevc' ? hevcRates(config, size, fps) : undefined;
  return {
    traits: { ...traits, family, fourcc },
    ...(size === undefined ? {} : { size }),
    ...(fps === undefined ? {} : { fps }),
    ...(bitDepth === undefined ? {} : { bitDepth }),
    alpha: config.alpha === true,
    ...(rates === undefined ? {} : { rates }),
  };
}

/** Rejects a frame size the codec's encoder cannot take. */
function checkFrameSize(codec: EncodeConfig['codec'], size: FrameSize): void {
  const { width, height } = size;
  if (codec === 'hevc') {
    if (
      width % 2 !== 0 ||
      height % 2 !== 0 ||
      width < 16 ||
      width > 16384 ||
      height < 16 ||
      height > 8192
    ) {
      throw invalidPreset(
        `codec 'hevc' needs an even frame size, 16–16384 wide and 16–8192 high; got ${width}x${height}.`,
      );
    }
    return;
  }
  if (width < 16 || width > 16384 || height < 16 || height > 16384) {
    throw invalidPreset(
      `codec '${codec}' needs a frame size of 16–16384 per side; got ${width}x${height}.`,
    );
  }
}

/**
 * HEVC rate control: the target and maximum bitrate (the config's, or AME's
 * default for the frame size) and the level. A default-rate config with no
 * fixed frame rate takes AME's own level for that exact size
 * ({@link HEVC_DEFAULT_RATES}); a fixed frame rate, or a custom bitrate,
 * instead computes the lowest H.265 Main-tier level admitting the picture
 * size, the sample rate — the fixed frame rate if one is given, else up to 60
 * fps — and the bitrate. `undefined` keeps the template's rates, which is the
 * case for a source-sized preset with no bitrate.
 */
function hevcRates(
  config: EncodeConfig,
  size: FrameSize | undefined,
  fps: number | undefined,
): EprPlan['rates'] {
  let target: number;
  let max: number;
  let pinnedLevel: HevcLevel | undefined;
  if (config.bitrate !== undefined) {
    target = bitrateBps(config.bitrate) / 1e6;
    if (target < HEVC_MIN_MBPS || target > HEVC_MAX_MBPS) {
      throw invalidPreset(
        `codec 'hevc' needs a bitrate between 192k and 240M; got ${quoted(config.bitrate)}.`,
      );
    }
    max = Math.min(Math.round(target * HEVC_PEAK_RATIO * 1000) / 1000, HEVC_MAX_MBPS);
  } else if (size !== undefined) {
    const pixels = size.width * size.height;
    const defaults = HEVC_DEFAULT_RATES.find((rate) => pixels <= rate.maxPixels)!;
    ({ target, max } = defaults);
    if (fps === undefined) pinnedLevel = defaults.level;
  } else {
    return undefined;
  }

  if (pinnedLevel !== undefined) return { level: pinnedLevel, target, max };

  // A source-driven frame rate is sized for sources up to 60 fps; a source-driven
  // frame size keeps the frame size AME stores for it.
  const frame = size ?? HEVC_TEMPLATE_SIZE;
  const pixels = frame.width * frame.height;
  const longest = Math.max(frame.width, frame.height);
  const samplesPerSecond = pixels * (fps ?? 60);
  const level = HEVC_LEVELS.find(
    (candidate) =>
      pixels <= candidate.maxLumaPs &&
      longest <= Math.sqrt(8 * candidate.maxLumaPs) &&
      samplesPerSecond <= candidate.maxLumaSr &&
      max <= candidate.maxMbps,
  );
  if (level === undefined) {
    throw invalidPreset(
      `codec 'hevc' cannot encode ${frame.width}x${frame.height} at ${fps ?? 'up to 60'} fps within HEVC level 6.2.`,
    );
  }
  return { level, target, max };
}

/** The HEVC template with `plan` patched in. */
function hevcXml(plan: EprPlan): string {
  let xml = HEVC_BASE_EPR;
  if (plan.size === undefined) {
    xml = patchParam(xml, 'ADBEVideoMatchSource', (b) => setArbData(b, MATCH_SOURCE.hevcAll));
    for (const id of HEVC_SOURCE_DRIVEN) {
      xml = patchParam(xml, id, (b) => setCompactDisabled(b, true));
    }
  } else {
    const { width, height } = plan.size;
    xml = patchParam(xml, 'ADBEVideoWidth', (b) => setElement(b, 'ParamValue', String(width)));
    xml = patchParam(xml, 'ADBEVideoHeight', (b) => setElement(b, 'ParamValue', String(height)));
    const fps = plan.fps;
    xml = patchParam(xml, 'ADBEVideoMatchSource', (b) =>
      setArbData(b, fps === undefined ? MATCH_SOURCE.hevcFrameRate : MATCH_SOURCE.none),
    );
    if (fps !== undefined) {
      xml = patchParam(xml, 'ADBEVideoFPS', (b) =>
        setCompactDisabled(setElement(b, 'ParamValue', String(ticksPerFrame(fps))), false),
      );
    }
  }
  if (plan.bitDepth !== undefined) {
    const profile = plan.bitDepth === 10 ? '2' : '1';
    xml = patchParam(xml, 'ADBEVideoMPEGProfile', (b) => setElement(b, 'ParamValue', profile));
  }
  if (plan.rates !== undefined) {
    const { level, target, max } = plan.rates;
    const ceiling = ameFloat(level.maxMbps);
    xml = patchParam(xml, 'ADBEVideoMPEGProfileLevel', (b) =>
      setElement(b, 'ParamValue', String(level.level)),
    );
    xml = patchParam(xml, 'ADBEVideoTargetBitrate', (b) =>
      setElement(setElement(b, 'ParamValue', ameFloat(target)), 'ParamMaxValue', ceiling),
    );
    xml = patchParam(xml, 'ADBEVideoMaxBitrate', (b) =>
      setElement(setElement(b, 'ParamValue', ameFloat(max)), 'ParamMaxValue', ceiling),
    );
  }
  return xml;
}

/** The QuickTime (ProRes) template with `plan` patched in. */
function quicktimeXml(plan: EprPlan): string {
  let xml = QUICKTIME_BASE_EPR;
  const codecValue = String(fourccValue(plan.traits.fourcc));
  xml = patchParam(xml, 'ADBEVideoCodec', (b) => setElement(b, 'ParamValue', codecValue));
  if (plan.size === undefined) {
    xml = patchParam(xml, 'ADBEVideoMatchSource', (b) => setArbData(b, MATCH_SOURCE.quicktimeAll));
  } else {
    const { width, height } = plan.size;
    xml = patchParam(xml, 'ADBEVideoWidth', (b) => setElement(b, 'ParamValue', String(width)));
    xml = patchParam(xml, 'ADBEVideoHeight', (b) => setElement(b, 'ParamValue', String(height)));
    const fps = plan.fps;
    xml = patchParam(xml, 'ADBEVideoMatchSource', (b) =>
      setArbData(b, fps === undefined ? MATCH_SOURCE.quicktimeFrameRate : MATCH_SOURCE.none),
    );
    if (fps !== undefined) {
      xml = patchParam(xml, 'ADBEVideoFPS', (b) =>
        setElement(b, 'ParamValue', String(ticksPerFrame(fps))),
      );
    }
  }
  // AME's ProRes 4444 presets store depth 4 (16-bpc) and 5 (16-bpc with alpha).
  xml = patchParam(xml, 'ADBEVideoBitDepth', (b) =>
    setElement(b, 'ParamValue', plan.alpha ? '5' : '4'),
  );
  return xml;
}

/** Replaces the template's name, description and `PresetID` with the generated preset's own. */
function withMetadata(xml: string, plan: EprPlan, presetId: string): string {
  let out = setTopLevel(xml, 'PresetName', escapeXml(presetName(plan)));
  out = setTopLevel(out, 'PresetComments', escapeXml(presetComments(plan)));
  return setTopLevel(out, 'PresetID', presetId);
}

/** `HEVC (H.265) 3840x2160 10-bit`, `Apple ProRes 4444 XQ with alpha`, … */
function presetName(plan: EprPlan): string {
  const parts = [plan.traits.label];
  if (plan.size !== undefined) parts.push(`${plan.size.width}x${plan.size.height}`);
  if (plan.fps !== undefined) parts.push(`${plan.fps} fps`);
  if (plan.traits.family === 'hevc' && plan.bitDepth !== undefined)
    parts.push(`${plan.bitDepth}-bit`);
  if (plan.alpha) parts.push('with alpha');
  return parts.join(' ');
}

/** A one-paragraph description naming the codec's FourCC, the AME exporter, and every setting. */
function presetComments(plan: EprPlan): string {
  const { family, fourcc, label, chroma } = plan.traits;
  const sampling = chroma === '444' ? '4:4:4' : '4:2:0';
  const settings = [
    plan.size === undefined
      ? 'Frame size follows the source'
      : `Frame size ${plan.size.width}x${plan.size.height}`,
    plan.fps === undefined ? 'frame rate follows the source' : `frame rate ${plan.fps} fps`,
  ];
  if (plan.bitDepth === undefined) settings.push(`bit depth follows the source, ${sampling}`);
  else if (family === 'hevc') {
    settings.push(`${plan.bitDepth}-bit ${sampling} (${plan.bitDepth === 10 ? 'Main10' : 'Main'})`);
  } else settings.push(`${plan.bitDepth}-bit ${sampling}`);
  if (plan.alpha) settings.push('alpha');
  if (plan.rates !== undefined) {
    const { level, target, max } = plan.rates;
    settings.push(`target ${target} Mbps, maximum ${max} Mbps, level ${level.level / 10}`);
  }
  return `Generated by firefly-audio-video: ${label}, video FourCC ${fourcc}, AME exporter ${EXPORTER_FOLDERS[family]}. ${settings.join('; ')}.`;
}

/**
 * A UUID-formatted digest of the rendered `.epr` body: RFC 9562 version 8. The
 * body already carries the template text and every patched value, so the same
 * body always yields the same id, and any change to the template or the patch
 * logic — both of which flow into the body — yields a different one.
 */
export function presetIdFor(body: string): string {
  const hex = createHash('sha256').update(body).digest('hex');
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** One `<ExporterParam>` element, which never nests another. */
const PARAM_BLOCK = /<ExporterParam ObjectID="\d+"[^>]*>[\s\S]*?<\/ExporterParam>/g;

/** An error for a template that no longer has the shape the patcher needs. */
function templateError(message: string): AudioVideoError {
  return new AudioVideoError({ message: `.epr template: ${message}`, code: 'internal_error' });
}

/** Applies `patch` to the one `<ExporterParam>` whose `ParamIdentifier` is `identifier`. */
function patchParam(xml: string, identifier: string, patch: (block: string) => string): string {
  const marker = `<ParamIdentifier>${identifier}</ParamIdentifier>`;
  let found = 0;
  const out = xml.replace(PARAM_BLOCK, (block) => {
    if (!block.includes(marker)) return block;
    found += 1;
    return patch(block);
  });
  if (found !== 1)
    throw templateError(`expected exactly one ${identifier} parameter, found ${found}.`);
  return out;
}

/** Replaces the text of the one `<tag>` element in `block`. */
function setElement(block: string, tag: string, text: string): string {
  const pattern = new RegExp(`<${tag}>[^<]*</${tag}>`);
  if (!pattern.test(block)) throw templateError(`parameter has no <${tag}> element.`);
  return block.replace(pattern, () => `<${tag}>${text}</${tag}>`);
}

/** Replaces a parameter's `<ParamArbData>` with `payload`. */
function setArbData(block: string, payload: MatchSourcePayload): string {
  const pattern = /<ParamArbData Encoding="base64" Checksum="\d+">[^<]*<\/ParamArbData>/;
  if (!pattern.test(block)) throw templateError('parameter has no <ParamArbData> element.');
  return block.replace(
    pattern,
    () =>
      `<ParamArbData Encoding="base64" Checksum="${payload.checksum}">${payload.data}</ParamArbData>`,
  );
}

/**
 * Sets a parameter's disabled flag in AME's compact format, where the flag is
 * written only when true — just before `ParamConstrainedListIsOptional` when the
 * parameter has one, otherwise just before `ParamIdentifier`.
 */
function setCompactDisabled(block: string, disabled: boolean): string {
  const stripped = block.replace(/\n\t\t<ParamIsDisabled>(?:true|false)<\/ParamIsDisabled>/, '');
  if (!disabled) return stripped;
  const anchor = stripped.includes('<ParamConstrainedListIsOptional>')
    ? '\t\t<ParamConstrainedListIsOptional>'
    : '\t\t<ParamIdentifier>';
  return stripped.replace(anchor, () => `\t\t<ParamIsDisabled>true</ParamIsDisabled>\n${anchor}`);
}

/** Replaces the text of the one top-level `<tag>` element in `xml`. */
function setTopLevel(xml: string, tag: string, text: string): string {
  const pattern = new RegExp(`<${tag}>[^<]*</${tag}>`, 'g');
  const count = xml.match(pattern)?.length ?? 0;
  if (count !== 1) throw templateError(`expected exactly one <${tag}> element, found ${count}.`);
  return xml.replace(pattern, () => `<${tag}>${text}</${tag}>`);
}

/** Escapes the five XML special characters. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * A number the way AME writes a float parameter: up to 25 significant digits,
 * trailing zeros dropped, the decimal point always kept (`16.`, `1.3000…44408921`).
 */
function ameFloat(value: number): string {
  return value.toPrecision(25).replace(/0+$/, '');
}

/** A FourCC as the 32-bit big-endian integer AME stores (`'ap4x'` → 1634743416). */
export function fourccValue(fourcc: string): number {
  let value = 0;
  for (const char of fourcc) value = value * 256 + char.charCodeAt(0);
  return value;
}

/** The FourCC a 32-bit big-endian integer spells (1634743416 → `'ap4x'`). */
export function fourccOf(value: number): string {
  return String.fromCharCode(
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  );
}

/** The system-preset folder name for an exporter: `ExporterClassID` + `ExporterFileType` as `%08X_%08X`. */
export function exporterFolder(classId: number, fileType: number): string {
  const hex = (n: number): string => n.toString(16).toUpperCase().padStart(8, '0');
  return `${hex(classId)}_${hex(fileType)}`;
}

/** A parameter's value and match-source payload, as read from an `.epr`. */
interface ParamReading {
  readonly value?: string;
  readonly arbData?: string;
}

/** The first `<ExporterParam>` per `ParamIdentifier`, with its value and payload. */
function readParams(xml: string): Map<string, ParamReading> {
  const params = new Map<string, ParamReading>();
  for (const [block] of xml.matchAll(PARAM_BLOCK)) {
    const id = /<ParamIdentifier>([^<]*)<\/ParamIdentifier>/.exec(block)?.[1];
    if (id === undefined || params.has(id)) continue;
    const value = /<ParamValue>([^<]*)<\/ParamValue>/.exec(block)?.[1];
    const arbData = /<ParamArbData[^>]*>([^<]*)<\/ParamArbData>/.exec(block)?.[1];
    params.set(id, {
      ...(value === undefined ? {} : { value }),
      ...(arbData === undefined ? {} : { arbData }),
    });
  }
  return params;
}

/** A finite number parsed from `text`, or `undefined`. */
function numberOf(text: string | undefined): number | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** The match-source bitmask a payload carries; `0` when there is none. */
function matchSourceMask(arbData: string | undefined): number {
  if (arbData === undefined) return 0;
  const bytes = Buffer.from(arbData, 'base64');
  return bytes.length >= 4 ? bytes.readUInt32LE(0) : 0;
}

/** HEVC `ADBEExportColorSpace` values; empty or `0` is Rec. 709. */
const HEVC_COLOR = { 1: 'rec2020', 2: 'hlg', 3: 'pq' } as const;
/** QuickTime `ADBEExportColorSpace` values; empty or `0` is Rec. 709. */
const QUICKTIME_COLOR = { 1: 'hlg', 2: 'pq' } as const;

/**
 * Best-effort headline of a real `.epr` — codec (from the exporter and, for
 * QuickTime, the video FourCC), frame size or match-source, a fixed frame rate,
 * bit depth, chroma, alpha, HEVC target bitrate and a non-Rec. 709 color space —
 * so a preset loaded from a file still inspects as JSON. Fields the file does
 * not determine are left out; input that is not an `.epr` yields `{}`. Never
 * throws.
 *
 * @example
 * ```ts
 * parseEprHeadline(toEpr({ codec: 'prores4444xq', alpha: true }));
 * // -> { codec: 'prores4444xq', matchSource: true, chroma: '444', bitDepth: 12, alpha: true }
 * ```
 */
export function parseEprHeadline(xml: string): Partial<EncodeConfig> {
  if (typeof xml !== 'string' || !xml.includes('<PremiereData')) return {};
  const classId = numberOf(/<ExporterClassID>([^<]*)<\/ExporterClassID>/.exec(xml)?.[1]);
  const fileType = numberOf(/<ExporterFileType>([^<]*)<\/ExporterFileType>/.exec(xml)?.[1]);
  const folder =
    classId === undefined || fileType === undefined ? undefined : exporterFolder(classId, fileType);
  const params = readParams(xml);
  const param = (id: string): number | undefined => numberOf(params.get(id)?.value);
  const mask = matchSourceMask(params.get('ADBEVideoMatchSource')?.arbData);
  const out: Partial<EncodeConfig> = {};

  if (folder === EXPORTER_FOLDERS.hevc) out.codec = 'hevc';
  else if (folder === EXPORTER_FOLDERS.h264) out.codec = 'h264';
  else if (folder === EXPORTER_FOLDERS.quicktime) {
    const codecValue = param('ADBEVideoCodec');
    const fourcc = codecValue === undefined ? undefined : fourccOf(codecValue);
    if (fourcc === CODEC_TRAITS.prores4444.fourcc) out.codec = 'prores4444';
    else if (fourcc === CODEC_TRAITS.prores4444xq.fourcc) out.codec = 'prores4444xq';
  }

  if ((mask & 1) !== 0) out.matchSource = true;
  else {
    const width = param('ADBEVideoWidth');
    const height = param('ADBEVideoHeight');
    if (width !== undefined && height !== undefined) out.resolution = `${width}x${height}`;
  }
  if ((mask & 4) === 0) {
    const ticks = param('ADBEVideoFPS');
    if (ticks !== undefined && ticks > 0) out.frameRate = frameRateOfTicks(ticks);
  }

  const colorValue = param('ADBEExportColorSpace') ?? 0;
  if (out.codec === 'hevc') {
    out.chroma = CODEC_TRAITS.hevc.chroma;
    const profile = param('ADBEVideoMPEGProfile');
    if ((mask & 32) === 0 && profile !== undefined) {
      if (profile === 1) out.bitDepth = 8;
      else if (profile === 2) out.bitDepth = 10;
    }
    const target = param('ADBEVideoTargetBitrate');
    if (target !== undefined && target > 0) out.bitrate = `${target}M`;
    const color = HEVC_COLOR[colorValue as keyof typeof HEVC_COLOR];
    if (color !== undefined) out.color = color;
  } else if (out.codec === 'prores4444' || out.codec === 'prores4444xq') {
    out.chroma = CODEC_TRAITS[out.codec].chroma;
    out.bitDepth = CODEC_TRAITS[out.codec].bitDepths[0];
    const depth = param('ADBEVideoBitDepth');
    if (depth === 5) out.alpha = true;
    else if (depth === 4) out.alpha = false;
    const color = QUICKTIME_COLOR[colorValue as keyof typeof QUICKTIME_COLOR];
    if (color !== undefined) out.color = color;
  }
  return out;
}
