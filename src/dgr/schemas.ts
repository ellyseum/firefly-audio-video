/**
 * zod schemas for the public, "friendly" input shapes of a DGR (Dynamic Graphics
 * Render) render request — plain strings for URLs and paths, no wire-format nesting.
 * These are the shapes a caller writes by hand, and the single source of truth for
 * both runtime validation (`.parse()`) and the exported TypeScript input types
 * (`z.infer`). `buildRenderBody` (./build-body.ts) validates a {@link RenderSpec}
 * with {@link RenderSpecSchema} before transforming it into the wire body DGR
 * actually expects (see ./types.ts and the proven substrate + gotchas).
 */

import * as z from 'zod';

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
 * The full set of properties DGR accepts varies by the target control's `type` (the
 * describe endpoint's `Controls` response in ./types.ts enumerates control types),
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
 * — `buildRenderBody` is what wraps it in the `{ url }` object the wire format
 * expects (the published API spec types `destination` as a bare string,
 * which is wrong; DGR requires the object form).
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

/**
 * The full JSON config for a codec, taken in one shot (the `Preset` JSON constructor
 * / `Preset.encode({...})`). `codec` + `bitDepth` + `chroma` + `bitrate`
 * are the four knobs that move output; `bitrate` and `mode` are alternative ways to
 * express rate control, and `resolution` and `matchSource` are alternative ways to
 * express target frame size — the spec presents each pair as alternatives without
 * defining a cross-field precedence rule, so both fields stay independently
 * optional here rather than mutually exclusive by construction. Only `codec` is
 * required; everything else is a knob a caller may omit.
 *
 * @example
 * ```ts
 * const config: EncodeConfig = { codec: 'ap4x', bitDepth: 10, chroma: '444', bitrate: '120M' };
 * ```
 */
export const EncodeConfigSchema = z.strictObject({
  codec: z.string().min(1, 'codec must not be empty'),
  bitDepth: z.number().int().positive('bitDepth must be a positive integer').optional(),
  /** 4:2:2 and 4:4:4 are the two chroma subsamplings proven for the custom `.epr` path. */
  chroma: z.enum(['422', '444'], { error: "chroma must be '422' or '444'" }).optional(),
  bitrate: z.string().min(1, 'bitrate must not be empty when provided').optional(),
  mode: z.string().min(1, 'mode must not be empty when provided').optional(),
  alpha: z.boolean().optional(),
  resolution: z.string().min(1, 'resolution must not be empty when provided').optional(),
  matchSource: z.boolean().optional(),
  frameRate: z.number().positive('frameRate must be a positive number').optional(),
  color: z.string().min(1, 'color must not be empty when provided').optional(),
});

/** A friendly {@link EncodeConfigSchema} input. */
export type EncodeConfig = z.infer<typeof EncodeConfigSchema>;

/**
 * The friendly, top-level input to a DGR render: one `.mogrt` capsule, the preset(s)
 * to encode it with, any assets referenced by template variables, per-variation
 * variable overrides, and the deliverables to produce. `buildRenderBody` validates a
 * value against this schema and then transforms it into the wire body DGR's
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

/** A friendly {@link RenderSpecSchema} input — the argument to `buildRenderBody` and `client.render()`. */
export type RenderSpec = z.infer<typeof RenderSpecSchema>;
