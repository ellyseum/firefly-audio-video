/**
 * zod schemas for the public, "friendly" input shapes of a DGR (Dynamic Graphics
 * Render) render request — plain strings for URLs and paths, no wire-format nesting.
 * These are the shapes a caller writes by hand, and the single source of truth for
 * both runtime validation (`.parse()`) and the exported TypeScript input types
 * (`z.infer`). A spec is validated against these schemas before it is turned
 * into the wire body DGR actually expects.
 */

import * as z from 'zod';
import { quoted } from '../presets/codecs.js';
import { PRESET_NAMES } from '../presets/names.js';
import type { PresetInput } from './preset.js';

/** Quotes and joins allowed values for an error message: `'a', 'b' or 'c'`. */
function oneOf(values: readonly (string | number)[]): string {
  const quoted = values.map((value) => (typeof value === 'string' ? `'${value}'` : String(value)));
  const last = quoted.pop() ?? '';
  return quoted.length > 0 ? `${quoted.join(', ')} or ${last}` : last;
}

/**
 * A reference to a render preset, in either of its two friendly forms: a presigned
 * URL to a staged `.epr` file, or the id of a DGR-native named preset (passthrough —
 * no `.epr` involved). Exactly one of `url` or `presetId` may be present; an object
 * carrying both, or neither, is rejected.
 *
 * @example
 * ```ts
 * const byUrl: PresetRef = { url: 'https://example.com/preset.epr?sig=…' };
 * const byId: PresetRef = { presetId: 'ffs_video_api_prores' };
 * ```
 */
export const PresetRefSchema = z.union(
  [
    z.strictObject({ url: z.string().min(1, 'url must not be empty') }),
    z.strictObject({ presetId: z.string().min(1, 'presetId must not be empty') }),
  ],
  { error: 'a preset ref must be either { url } or { presetId }, not both and not neither' },
);

/** A friendly {@link PresetRefSchema} input: `{ url }` (a staged `.epr`) or `{ presetId }` (native). */
export type PresetRef = z.infer<typeof PresetRefSchema>;

/**
 * A single template-variable override applied within one render variation — for
 * example binding a media control to an uploaded asset, or setting its scale mode.
 * The full set of properties DGR accepts varies by the target control's `type` (as
 * reported for each `TemplateControl` a `describe()` call returns),
 * so beyond the proven `variableId` / `assetIndex` / `scale` / `value` fields this
 * schema keeps any other caller-supplied properties intact rather than silently
 * stripping them — the render-body example is one proven instance, not
 * an exhaustive contract for every control type.
 *
 * @example
 * ```ts
 * const variable: RenderVariable = { variableId: '0_0_media', assetIndex: 0, scale: 'fit_to_frame' };
 * ```
 */
export const RenderVariableSchema = z.looseObject({
  variableId: z.string().min(1, 'variableId must not be empty'),
  assetIndex: z.number().int().nonnegative('assetIndex must be a non-negative integer').optional(),
  scale: z.string().min(1, 'scale must not be empty when provided').optional(),
  value: z.string().optional(),
});

/** A friendly {@link RenderVariableSchema} input. */
export type RenderVariable = z.infer<typeof RenderVariableSchema>;

/**
 * One deliverable of a render job: which variation and preset produce it, and where
 * the finished asset should land. `destination` is a plain presigned write URL here
 * — the SDK wraps it in the `{ url }` object the wire format expects (the
 * published API spec types `destination` as a bare string, which is wrong; DGR
 * requires the object form).
 *
 * @example
 * ```ts
 * const output: RenderOutput = {
 *   presetIndex: 0,
 *   fileName: 'out.mov',
 *   destination: 'https://example.com/dst?sig=…',
 * };
 * ```
 */
export const RenderOutputSchema = z.strictObject({
  variationIndex: z
    .number()
    .int()
    .nonnegative('variationIndex must be a non-negative integer')
    .optional(),
  presetIndex: z.number().int().nonnegative('presetIndex must be a non-negative integer'),
  fileName: z.string().min(1, 'fileName must not be empty when provided').optional(),
  destination: z.string().min(1, 'destination must not be empty'),
});

/** A friendly {@link RenderOutputSchema} input. */
export type RenderOutput = z.infer<typeof RenderOutputSchema>;

/** The codecs a preset can target. */
export const CODECS = ['h264', 'hevc', 'prores4444', 'prores4444xq'] as const;

/**
 * A preset's codec: `'h264'` (DGR's native presets only), `'hevc'` (H.265),
 * `'prores4444'` (Apple ProRes 4444) or `'prores4444xq'` (Apple ProRes 4444 XQ).
 */
export const CodecSchema = z.enum(CODECS, {
  error: (issue) =>
    issue.input === undefined
      ? `codec is required: one of ${oneOf(CODECS)} (a preset from an empty base, resize(), or a URL-loaded .epr has no codec; add one with .with({ codec })).`
      : `codec must be one of ${oneOf(CODECS)}; got ${quoted(issue.input)}`,
});

/** A {@link CodecSchema} value. */
export type Codec = z.infer<typeof CodecSchema>;

/** The chroma subsamplings a config can name. */
export const CHROMAS = ['420', '422', '444'] as const;

/** Chroma subsampling: `'420'` (4:2:0), `'422'` (4:2:2) or `'444'` (4:4:4). */
export const ChromaSchema = z.enum(CHROMAS, { error: `chroma must be ${oneOf(CHROMAS)}` });

/** A {@link ChromaSchema} value. */
export type Chroma = z.infer<typeof ChromaSchema>;

/** The bit depths a config can name. */
export const BIT_DEPTHS = [8, 10, 12] as const;

/** Bits per sample: `8`, `10` or `12`. */
export const BitDepthSchema = z.literal(BIT_DEPTHS, {
  error: `bitDepth must be ${oneOf(BIT_DEPTHS)}`,
});

/** A {@link BitDepthSchema} value. */
export type BitDepth = z.infer<typeof BitDepthSchema>;

const BITRATE_MESSAGE =
  "bitrate must be a positive number of bits per second, or a string such as '120M' or '2500k'";

/**
 * A target bitrate: a number of bits per second, or a string with an optional
 * `k` (kilobits) or `M` (megabits) suffix in either case — `'120M'`, `'2500k'`,
 * `'8000000'`.
 */
export const BitrateSchema = z.union(
  [
    z.string().regex(/^(?:\d+(?:\.\d+)?|\.\d+)[kKmM]?$/, { error: BITRATE_MESSAGE }),
    z.number().positive({ error: BITRATE_MESSAGE }),
  ],
  { error: BITRATE_MESSAGE },
);

/** A {@link BitrateSchema} value. */
export type Bitrate = z.infer<typeof BitrateSchema>;

/** The rate tiers of DGR's native H.264 presets. */
export const MODES = ['hq', 'lq', '2pass'] as const;

/**
 * One of DGR's native H.264 rate tiers: `'hq'`, `'lq'` or `'2pass'` (two-pass
 * VBR) — the suffixes of the `ffs_video_api_*` preset ids.
 */
export const ModeSchema = z.enum(MODES, { error: `mode must be ${oneOf(MODES)}` });

/** A {@link ModeSchema} value. */
export type Mode = z.infer<typeof ModeSchema>;

/** A frame size written as `'<width>x<height>'`, e.g. `'1920x1080'`. */
export type ResolutionString = `${number}x${number}`;

const RESOLUTION_PATTERN = /^[1-9]\d*x[1-9]\d*$/;
const RESOLUTION_MESSAGE =
  "resolution must be a 'WxH' string such as '1920x1080', or { width, height } in whole pixels";

/** An output frame size: `'1920x1080'`, or `{ width: 1920, height: 1080 }`. */
export const ResolutionSchema = z.union(
  [
    z.custom<ResolutionString>(
      (value) => typeof value === 'string' && RESOLUTION_PATTERN.test(value),
      { error: RESOLUTION_MESSAGE },
    ),
    z.strictObject(
      {
        width: z.int({ error: RESOLUTION_MESSAGE }).positive({ error: RESOLUTION_MESSAGE }),
        height: z.int({ error: RESOLUTION_MESSAGE }).positive({ error: RESOLUTION_MESSAGE }),
      },
      { error: RESOLUTION_MESSAGE },
    ),
  ],
  { error: RESOLUTION_MESSAGE },
);

/** A {@link ResolutionSchema} value. */
export type Resolution = z.infer<typeof ResolutionSchema>;

/**
 * The full encode config for a preset, taken in one shot (`new Preset({...})`,
 * `Preset.encode({...})`, `encode({...})`). Only `codec` is required.
 *
 * - **Frame size:** `resolution` fixes it; without one the output matches the
 *   source's frame size. When both `resolution` and `matchSource: true` are
 *   present, `resolution` wins.
 * - **Frame rate:** `frameRate` fixes it and needs a `resolution`; otherwise the
 *   frame rate follows the source.
 * - **Rate control:** `bitrate` sets HEVC's target; `mode` picks one of DGR's
 *   native H.264 tiers. ProRes has a fixed data rate per frame size and takes
 *   neither.
 *
 * This schema checks each field's type. Whether a codec can produce a
 * combination — 4:4:4 HEVC, 10-bit ProRes 4444 — is checked when the preset
 * resolves at render time, with an error naming what the codec supports.
 *
 * @example
 * ```ts
 * const config: EncodeConfig = { codec: 'hevc', bitDepth: 10, resolution: '3840x2160', bitrate: '40M' };
 * ```
 */
export const EncodeConfigSchema = z.strictObject({
  /** The target codec. */
  codec: CodecSchema,
  /** Bits per sample: HEVC encodes 8 (Main) or 10 (Main10); ProRes 4444 and 4444 XQ are 12-bit. */
  bitDepth: BitDepthSchema.optional(),
  /** Chroma subsampling: HEVC and H.264 are `'420'`; ProRes 4444 and 4444 XQ are `'444'`. */
  chroma: ChromaSchema.optional(),
  /** HEVC target bitrate — bits per second, or `'120M'` / `'2500k'`. */
  bitrate: BitrateSchema.optional(),
  /** One of DGR's native H.264 rate tiers; see {@link ModeSchema}. H.264 only; any other codec rejects it at render time. */
  mode: ModeSchema.optional(),
  /** Encode an alpha channel (ProRes 4444 and 4444 XQ). */
  alpha: z.boolean().optional(),
  /** Output frame size; see {@link ResolutionSchema}. */
  resolution: ResolutionSchema.optional(),
  /** Match the source's frame size — the default whenever `resolution` is absent. */
  matchSource: z.boolean().optional(),
  /** Output frame rate in frames per second (e.g. `29.97`); needs a `resolution`. */
  frameRate: z.number().positive({ error: 'frameRate must be a positive number' }).optional(),
  /** Color space; generated `.epr` files cover Rec. 709 (`'rec709'`). */
  color: z.string().min(1, 'color must not be empty when provided').optional(),
});

/** A friendly {@link EncodeConfigSchema} input. */
export type EncodeConfig = z.infer<typeof EncodeConfigSchema>;

/**
 * A preset name from the catalog — `'prores'`, `'prores4444xq'`,
 * `'hevc1080p10bit'`, `'h264Land1080pHq'`, … — the typed string form of a named
 * preset.
 */
export const PresetNameSchema = z.enum(PRESET_NAMES, {
  error: (issue) =>
    `unknown preset name ${quoted(issue.input)}; expected one of ${PRESET_NAMES.join(', ')}`,
});

/** A {@link PresetNameSchema} value. */
export type PresetName = z.infer<typeof PresetNameSchema>;

/**
 * The friendly, top-level input to a DGR render: one `.mogrt` capsule, the preset(s)
 * to encode it with, any assets referenced by template variables, per-variation
 * variable overrides, and the deliverables to produce. A spec is validated against
 * this schema before it is turned into the wire body DGR's
 * `POST /v1/templates/render` expects.
 *
 * @example
 * ```ts
 * const spec: RenderSpec = {
 *   source: 'https://example.com/capsule.mogrt?sig=…',
 *   presets: [{ presetId: 'ffs_video_api_prores' }],
 *   outputs: [{ presetIndex: 0, destination: 'https://example.com/out.mov?sig=…' }],
 * };
 * ```
 */
export const RenderSpecSchema = z.strictObject({
  source: z.string().min(1, 'source must not be empty'),
  presets: z.array(PresetRefSchema).min(1, 'at least one preset is required'),
  assets: z.array(z.string().min(1, 'asset url must not be empty')).optional(),
  variations: z.array(z.strictObject({ variables: z.array(RenderVariableSchema) })).optional(),
  outputs: z.array(RenderOutputSchema).min(1, 'at least one output is required'),
});

/** A friendly {@link RenderSpecSchema} input — a valid spec for `render()`. */
export type RenderSpec = z.infer<typeof RenderSpecSchema>;

/**
 * One deliverable of a {@link RenderRequest}: a {@link RenderOutput} plus an
 * optional `readUrl`, the URL the finished file is read back from. DGR writes
 * to `destination`, and a presigned write URL usually cannot be read, so pass
 * the read URL of the same object here. Without one, the asset's URL is
 * `destination` itself, which works only when that URL also grants read access.
 */
export const RenderRequestOutputSchema = RenderOutputSchema.extend({
  readUrl: z.string().min(1, 'readUrl must not be empty when provided').optional(),
});

/** A friendly {@link RenderRequestOutputSchema} input. */
export type RenderRequestOutput = z.infer<typeof RenderRequestOutputSchema>;

/**
 * The spec `render()` takes: a {@link RenderSpec} whose `presets[]` entries may
 * be any preset input — a `Preset`, an `EncodeConfig`, a catalog name, a DGR
 * `presetId`, an `.epr` file path, raw `.epr` XML, an http(s) URL to a staged
 * `.epr`, or a `{ presetId }` / `{ url }` reference — and whose outputs may
 * carry a `readUrl`. Every preset is resolved, and every generated `.epr`
 * staged through the client's storage, before the wire body is built.
 *
 * @example
 * ```ts
 * const spec: RenderRequest = {
 *   source: 'https://example.com/capsule.mogrt?sig=…',
 *   presets: [presets.hevc1080p10bit, 'h264Land1080pHq'],
 *   outputs: [
 *     { presetIndex: 0, destination: hevcWriteUrl, readUrl: hevcReadUrl },
 *     { presetIndex: 1, destination: h264WriteUrl, readUrl: h264ReadUrl },
 *   ],
 * };
 * ```
 */
export const RenderRequestSchema = RenderSpecSchema.extend({
  presets: z
    .array(
      z.custom<PresetInput | PresetRef>((value) => value !== undefined && value !== null, {
        error: 'a preset must not be null or undefined',
      }),
    )
    .min(1, 'at least one preset is required'),
  outputs: z.array(RenderRequestOutputSchema).min(1, 'at least one output is required'),
});

/** A friendly {@link RenderRequestSchema} input — the spec `render()` takes. */
export type RenderRequest = z.infer<typeof RenderRequestSchema>;
