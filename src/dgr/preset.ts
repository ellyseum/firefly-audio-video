/**
 * The chainable, immutable, lazily-resolved {@link Preset}: a JSON encode config
 * — or a named catalog entry, or a real `.epr` — that becomes a DGR preset
 * reference only at render time, as a native `presetId` when the config matches
 * one and as a generated, staged `.epr` otherwise.
 */

import { readFileSync, statSync } from 'node:fs';
import { brandClass, sharedKey } from '../core/brand.js';
import { AudioVideoError } from '../core/errors.js';
import {
  ASPECT_RESOLUTIONS,
  NAMED,
  nameForPresetId,
  type AspectRatio,
} from '../presets/catalog.js';
import { canonicalKey, invalidPreset, parseOrThrow, quoted } from '../presets/codecs.js';
import { parseEprHeadline, toEpr } from '../presets/epr.js';
import { PRESET_NAMES } from '../presets/names.js';
import {
  EncodeConfigSchema,
  PresetNameSchema,
  type BitDepth,
  type Bitrate,
  type Chroma,
  type EncodeConfig,
  type PresetName,
  type PresetRef,
  type ResolutionString,
} from './schemas.js';

/** How a {@link Preset} was built: from the catalog, from an encode config, or from a real `.epr`. */
export type PresetKind = 'named' | 'config' | 'epr';

/** The JSON form of a {@link Preset} — never XML. */
export interface PresetJSON {
  kind: PresetKind;
  /** The catalog name, for a named preset. */
  name?: PresetName;
  /** The effective encode config; for an `.epr` preset, the headline fields read from the file. */
  config: Partial<EncodeConfig>;
}

/** A `resize` target: an aspect ratio on DGR's native ladder, or an explicit `'WxH'` frame size. */
export type ResizeTarget = AspectRatio | ResolutionString;

/**
 * Anything {@link toPreset} accepts: a {@link Preset}, an {@link EncodeConfig},
 * a catalog name, a DGR-native `presetId`, an `.epr` file path, raw `.epr` XML,
 * or an http(s) URL to an already-staged `.epr`.
 */
export type PresetInput = Preset | EncodeConfig | PresetName | (string & NonNullable<unknown>);

/** @internal Hooks {@link resolvePreset} calls at render time. */
export interface ResolvePresetContext {
  /** Uploads `.epr` XML and resolves with a URL DGR can read it from. */
  stage: (xml: string) => Promise<string>;
  /**
   * Maps an effective config to a DGR-native `presetId`, or `null` when none
   * matches. Defaults to an exact match against the catalog's native presets.
   */
  matchNamed?: (config: EncodeConfig) => string | null;
}

type EprSource = { readonly url: string } | { readonly xml: string };

type PresetState =
  | { readonly kind: 'named'; readonly name: PresetName }
  | { readonly kind: 'config'; readonly config: Readonly<Partial<EncodeConfig>> }
  | {
      readonly kind: 'epr';
      readonly source: EprSource;
      readonly headline: Readonly<Partial<EncodeConfig>>;
    };

/** One getter per catalog name, each returning a fresh named {@link Preset}. */
type NamedAccessors = { readonly [K in PresetName]: Preset };

/**
 * Types `Preset`'s generated catalog accessors — the static ones through this
 * base's static side, the instance ones through its instance type. The getters
 * themselves are defined in `Preset`'s static block.
 */
const NamedAccessorBase = class {} as unknown as { new (): NamedAccessors } & NamedAccessors;

const EMPTY_CONFIG: Readonly<Partial<EncodeConfig>> = Object.freeze({});

/** Validates a `with()` overrides object: every field optional, no unknown keys. */
const OVERRIDES_SCHEMA = EncodeConfigSchema.partial();

/** The key every copy of the package reads a preset's state through, a preset another copy built included. */
const PRESET_STATE = sharedKey('Preset.state');

let stateOf: (preset: Preset) => PresetState;
let presetFrom: (state: PresetState) => Preset;

/**
 * A render preset: plain JSON at heart, resolved to what DGR needs only at
 * render time. Build one from the named catalog (`Preset.prores`,
 * `Preset.hevc1080p10bit`, `Preset.h264Land1080pHq`, … — or `presets.prores`),
 * from a full encode config (`new Preset({...})`, `Preset.encode({...})`), or
 * from a real `.epr` (`Preset.fromEpr(pathOrXmlOrUrl)`).
 *
 * Every modifier returns a new `Preset`; none mutates. At render time a preset
 * whose effective config equals a DGR-native preset resolves to that
 * `presetId`; any other config is generated as an `.epr` and staged. The
 * catalog accessors exist on the class and on every instance and ignore the
 * instance they are read from. When a process loads both of the package's
 * builds, a preset either one made passes `instanceof Preset` and renders
 * through the other.
 *
 * `toJSON()`, `toString()` and `console.log` all show the JSON form — never XML.
 *
 * @example
 * ```ts
 * Preset.prores.resize('9:16');                     // ProRes 4444 + alpha at 1080x1920
 * Preset.encode({ codec: 'hevc', bitDepth: 10 }).resize('3840x2160').bitrate('40M');
 * presets.h264Land1080pLq.resize('9:16');            // resolves to ffs_video_api_vert_1920p_lq
 * Preset.fromEpr('./My Custom Preset.epr');          // staged as-is at render time
 * ```
 */
export class Preset extends NamedAccessorBase {
  #state: PresetState;

  /**
   * @param config - A full encode config (validated here), or nothing for an
   *   empty base to chain from.
   * @throws {@link AudioVideoError} — `code: 'invalid_preset'` — when `config`
   *   fails validation; the message names every invalid field.
   */
  constructor(config?: EncodeConfig) {
    super();
    this.#state =
      config === undefined
        ? { kind: 'config', config: EMPTY_CONFIG }
        : {
            kind: 'config',
            config: freezeConfig(parseOrThrow(EncodeConfigSchema, config, 'preset config')),
          };
    Object.freeze(this);
  }

  /** How this preset was built — see {@link PresetKind}. */
  get kind(): PresetKind {
    return this.#state.kind;
  }

  /**
   * A preset from a full encode config — the same as `new Preset(config)`.
   *
   * @example
   * ```ts
   * const master = Preset.encode({ codec: 'prores4444xq', alpha: true });
   * ```
   */
  static encode(config: EncodeConfig): Preset {
    return new Preset(config);
  }

  /**
   * A preset from a real Adobe Media Encoder `.epr`: a file path, the raw XML,
   * or an http(s) URL where the `.epr` is already staged. The file or XML is
   * staged as-is at render time (a URL is used directly); its headline fields
   * (codec, frame size, bit depth, alpha, …) are read into the JSON view.
   * Modifying the result switches to a generated preset built from those
   * headline fields — the rest of the original file is not carried over.
   *
   * @throws {@link AudioVideoError} — `code: 'invalid_preset'` — when `src` is
   *   empty, the file cannot be read, or the content is not an `.epr`.
   */
  static fromEpr(src: string): Preset {
    if (typeof src !== 'string' || src.trim() === '') {
      throw invalidPreset(
        'Preset.fromEpr expects an .epr file path, raw .epr XML, or an http(s) URL to a staged .epr.',
      );
    }
    const text = src.trim();
    if (isHttpUrl(text)) {
      return presetFrom({ kind: 'epr', source: { url: text }, headline: EMPTY_CONFIG });
    }
    const xml = looksLikeXml(text) ? src : readEprFile(text);
    if (!xml.includes('<PremiereData')) {
      throw invalidPreset(
        `${looksLikeXml(text) ? 'The XML' : `The file at ${quoted(text)}`} is not an Adobe Media Encoder preset: it has no <PremiereData> element.`,
      );
    }
    return presetFrom({
      kind: 'epr',
      source: { xml },
      headline: freezeConfig(parseEprHeadline(xml)),
    });
  }

  /**
   * A new preset with `overrides` merged over this one's effective config.
   * Setting `resolution` replaces an inherited `matchSource`, and setting
   * `matchSource: true` replaces an inherited `resolution`; a key set to
   * `undefined` removes that field.
   *
   * @throws {@link AudioVideoError} — `code: 'invalid_preset'` — when an
   *   override fails validation.
   */
  with(overrides: Partial<EncodeConfig>): Preset {
    parseOrThrow(OVERRIDES_SCHEMA, overrides, 'preset overrides');
    const merged: Record<string, unknown> = { ...effectiveConfig(this.#state) };
    if (overrides.resolution !== undefined) delete merged.matchSource;
    if (overrides.matchSource === true) delete merged.resolution;
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
    return presetFrom({ kind: 'config', config: freezeConfig(merged as Partial<EncodeConfig>) });
  }

  /** The same as {@link Preset.with}. */
  extend(overrides: Partial<EncodeConfig>): Preset {
    return this.with(overrides);
  }

  /**
   * A new preset at a fixed frame size: an aspect ratio on DGR's native ladder
   * (`'16:9'` 1920x1080, `'1:1'` 1080x1080, `'9:16'` 1080x1920, `'2:3'`
   * 1080x1620, `'4:5'` 1080x1350) or an explicit `'WxH'`.
   *
   * @throws {@link AudioVideoError} — `code: 'invalid_preset'` — for any other target.
   */
  resize(target: ResizeTarget): Preset {
    return this.with({ resolution: resolutionFor(target) });
  }

  /** A new preset with `bitDepth` set (`8`, `10` or `12`). */
  bitDepth(bits: BitDepth): Preset {
    return this.with({ bitDepth: bits });
  }

  /** A new preset with a target `bitrate` — bits per second, or `'120M'` / `'2500k'`. */
  bitrate(value: Bitrate): Preset {
    return this.with({ bitrate: value });
  }

  /** A new preset with `chroma` set (`'420'`, `'422'` or `'444'`). */
  chroma(value: Chroma): Preset {
    return this.with({ chroma: value });
  }

  /** A new preset with an alpha channel on (the default) or off. */
  alpha(on = true): Preset {
    return this.with({ alpha: on });
  }

  /** The JSON form — `{ kind, name?, config }`, never XML. */
  toJSON(): PresetJSON {
    const state = this.#state;
    return {
      kind: state.kind,
      ...(state.kind === 'named' ? { name: state.name } : {}),
      config: cloneConfig(effectiveConfig(state)),
    };
  }

  /** {@link Preset.toJSON}, serialized. */
  toString(): string {
    return JSON.stringify(this.toJSON());
  }

  /**
   * Backs `util.inspect(preset)` / `console.log(preset)` — the same shape as
   * {@link Preset.toJSON}. `Symbol.for('nodejs.util.inspect.custom')` is the symbol
   * Node exposes as `util.inspect.custom`.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): PresetJSON {
    return this.toJSON();
  }

  static {
    brandClass(this, 'Preset');
    // Each copy of the package reads its own presets' state directly, and another copy's
    // through this accessor: the field itself is private to the class that declared it.
    Object.defineProperty(this.prototype, PRESET_STATE, {
      value(this: Preset): PresetState {
        return this.#state;
      },
    });
    stateOf = (preset) =>
      #state in preset
        ? preset.#state
        : (preset as unknown as Record<symbol, () => PresetState>)[PRESET_STATE]!();
    presetFrom = (state) => {
      const preset = new Preset();
      preset.#state = state;
      return preset;
    };
    for (const name of PRESET_NAMES) {
      const get = (): Preset => presetFrom({ kind: 'named', name });
      Object.defineProperty(this, name, { get, enumerable: false });
      Object.defineProperty(this.prototype, name, { get, enumerable: false });
    }
  }
}

/** The config a state stands for: a catalog entry's, a builder's own, or an `.epr`'s headline. */
function effectiveConfig(state: PresetState): Readonly<Partial<EncodeConfig>> {
  switch (state.kind) {
    case 'named':
      return NAMED[state.name].config;
    case 'config':
      return state.config;
    case 'epr':
      return state.headline;
  }
}

/** A frozen copy of `config`, including a `{ width, height }` resolution. */
function freezeConfig(config: Partial<EncodeConfig>): Readonly<Partial<EncodeConfig>> {
  return Object.freeze(cloneConfig(config));
}

/** A shallow copy of `config` that also copies a `{ width, height }` resolution. */
function cloneConfig(config: Readonly<Partial<EncodeConfig>>): Partial<EncodeConfig> {
  const copy: Partial<EncodeConfig> = { ...config };
  if (typeof config.resolution === 'object') copy.resolution = { ...config.resolution };
  return copy;
}

const WXH_PATTERN = /^[1-9]\d*x[1-9]\d*$/;

/** The frame size a {@link ResizeTarget} names. */
function resolutionFor(target: ResizeTarget): ResolutionString {
  if (typeof target === 'string' && Object.hasOwn(ASPECT_RESOLUTIONS, target)) {
    return ASPECT_RESOLUTIONS[target as AspectRatio];
  }
  if (typeof target === 'string' && WXH_PATTERN.test(target)) return target as ResolutionString;
  const aspects = Object.keys(ASPECT_RESOLUTIONS)
    .map((aspect) => `'${aspect}'`)
    .join(', ');
  throw invalidPreset(
    `resize target must be one of ${aspects} or a 'WxH' size such as '1920x1080'; got ${quoted(target)}.`,
  );
}

/** True for an `http:` or `https:` URL. */
function isHttpUrl(text: string): boolean {
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

/** True when `text` opens like `.epr` XML (after any byte-order mark). */
function looksLikeXml(text: string): boolean {
  const body = text.replace(/^\uFEFF/, '');
  return body.startsWith('<?xml') || body.startsWith('<PremiereData');
}

/** The contents of the `.epr` file at `path`. */
function readEprFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw invalidPreset(`Could not read the .epr file at ${quoted(path)}.`, error);
  }
}

/** True when `path` names an existing regular file. */
function isFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

const EXPECTED_PRESET = `Expected a preset name (${PRESET_NAMES.join(', ')}), a DGR presetId (ffs_video_api_…), an EncodeConfig object, an .epr file path, raw .epr XML, or an http(s) URL to a staged .epr.`;

/**
 * Normalizes anything a preset may be given as to a {@link Preset}, in this
 * order: a `Preset` as-is; an {@link EncodeConfig} object → `new Preset(config)`;
 * a catalog name → the named preset; one of DGR's sixteen native `presetId`s →
 * the named preset for it; raw `.epr` XML, an http(s) URL, a string ending
 * `.epr`, or the path of an existing file → {@link Preset.fromEpr}.
 *
 * A string is checked as a filesystem path before being rejected, so never
 * pass untrusted input as a preset string: a path that happens to exist is
 * read and staged as its `.epr` contents.
 *
 * @throws {@link AudioVideoError} — `code: 'invalid_preset'` — for anything
 *   else, with a message listing the valid names.
 *
 * @example
 * ```ts
 * toPreset('prores');                           // Preset.prores
 * toPreset('ffs_video_api_vert_1920p_hq');      // Preset.h264Vert1920pHq
 * toPreset({ codec: 'hevc', bitDepth: 10, resolution: '1920x1080' });
 * toPreset('./masters/prores-4444-xq.epr');
 * ```
 */
export function toPreset(input: PresetInput): Preset {
  if (input instanceof Preset) return input;
  if (typeof input === 'string') return presetFromString(input);
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    if ('kind' in input && 'config' in input) {
      throw invalidPreset(
        "this is a Preset's JSON form (toJSON()); pass the Preset itself, or its .config, not the JSON.",
      );
    }
    return new Preset(input);
  }
  throw invalidPreset(
    `Unrecognized preset of type ${input === null ? 'null' : typeof input}. ${EXPECTED_PRESET}`,
  );
}

/** {@link toPreset} for a string. */
function presetFromString(input: string): Preset {
  const text = input.trim();
  const name = PresetNameSchema.safeParse(text);
  if (name.success) return Preset[name.data];
  const nativeName = nameForPresetId(text);
  if (nativeName !== undefined) return Preset[nativeName];
  if (
    looksLikeXml(text) ||
    isHttpUrl(text) ||
    text.toLowerCase().endsWith('.epr') ||
    isFile(text)
  ) {
    return Preset.fromEpr(input);
  }
  throw invalidPreset(`Unknown preset ${quoted(text)}. ${EXPECTED_PRESET}`);
}

/** Canonical keys of the catalog's native presets, built on first use. */
let nativeKeys: Map<string, string> | undefined;

/** The native `presetId` whose config equals `config` in canonical form, or `null`. */
function matchNativePreset(config: EncodeConfig): string | null {
  nativeKeys ??= new Map(
    Object.values(NAMED).flatMap((entry) =>
      entry.kind === 'passthrough' ? [[canonicalKey(entry.config), entry.presetId] as const] : [],
    ),
  );
  return nativeKeys.get(canonicalKey(config)) ?? null;
}

/** Stages `xml` through the context and checks the URL it resolves with. */
async function stageXml(ctx: ResolvePresetContext, xml: string): Promise<string> {
  if (typeof ctx?.stage !== 'function') {
    throw new AudioVideoError({
      message: 'resolvePreset: this preset needs staging, so the context must provide stage().',
      code: 'invalid_argument',
    });
  }
  const url = await ctx.stage(xml);
  if (typeof url !== 'string' || url === '') {
    throw new AudioVideoError({
      message: 'resolvePreset: stage() must resolve with the URL of the staged .epr.',
      code: 'invalid_argument',
    });
  }
  return url;
}

/**
 * Resolves a {@link Preset} to the {@link PresetRef} a render body carries — the
 * render-time step. A named passthrough preset resolves to its `presetId`; a
 * config (a builder, a named `.epr` entry, any chained result) resolves to the
 * `presetId` its effective config matches, or else to the URL of its generated
 * `.epr`, staged through `ctx.stage`; an `.epr` preset resolves to its URL, or
 * stages its XML as-is. Returns the public `{ presetId }` / `{ url }` shape;
 * the wire's `{ source: … }` wrapping belongs to `buildRenderBody`.
 *
 * @throws {@link AudioVideoError} — `code: 'invalid_preset'` when the config
 *   has no codec or asks for something its codec cannot produce;
 *   `code: 'invalid_argument'` when `preset` is not a `Preset` or `stage`
 *   resolves with something other than a URL string.
 *
 * @internal
 */
export async function resolvePreset(preset: Preset, ctx: ResolvePresetContext): Promise<PresetRef> {
  if (!(preset instanceof Preset)) {
    throw new AudioVideoError({
      message: 'resolvePreset expects a Preset; normalize other inputs with toPreset() first.',
      code: 'invalid_argument',
    });
  }
  const state = stateOf(preset);
  if (state.kind === 'epr') {
    return 'url' in state.source
      ? { url: state.source.url }
      : { url: await stageXml(ctx, state.source.xml) };
  }
  if (state.kind === 'named') {
    const entry = NAMED[state.name];
    if (entry.kind === 'passthrough') return { presetId: entry.presetId };
  }
  const config = parseOrThrow(EncodeConfigSchema, effectiveConfig(state), 'preset config');
  const presetId = (ctx?.matchNamed ?? matchNativePreset)(config);
  if (typeof presetId === 'string' && presetId !== '') return { presetId };
  return { url: await stageXml(ctx, toEpr(config)) };
}

/**
 * The named catalog as a plain object — `presets.prores`, `presets.hevc4k10bit`,
 * … — each read returning a fresh {@link Preset}, the same as the matching
 * `Preset` static.
 */
export const presets: NamedAccessors = Object.freeze(
  Object.defineProperties(
    {},
    Object.fromEntries(
      PRESET_NAMES.map((name) => [name, { get: (): Preset => Preset[name], enumerable: true }]),
    ),
  ),
) as NamedAccessors;

/**
 * A preset from a full encode config — {@link Preset.encode} as a function.
 *
 * @example
 * ```ts
 * const hevc = encode({ codec: 'hevc', bitDepth: 10, resolution: '1920x1080' });
 * ```
 */
export const encode = Preset.encode;

/**
 * An empty base preset at a fixed frame size — `new Preset().resize(target)`;
 * chain `.with({ codec })` to finish it.
 *
 * @example
 * ```ts
 * resize('9:16').with({ codec: 'hevc' });
 * ```
 */
export function resize(target: ResizeTarget): Preset {
  return new Preset().resize(target);
}
