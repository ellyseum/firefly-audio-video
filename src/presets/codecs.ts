/**
 * Codec facts and config normalization shared by the preset builder and the
 * `.epr` serializer: what each codec produces, how a config's values normalize
 * (frame size, bitrate, frame rate), and the canonical form two configs are
 * compared in.
 */

import type * as z from 'zod';
import { AudioVideoError } from '../core/errors.js';
import type { BitDepth, Bitrate, Chroma, Codec, EncodeConfig, Resolution } from '../dgr/schemas.js';

/** What a codec produces and which config fields it accepts. */
export interface CodecTraits {
  /** Human-readable codec name, for error messages and preset descriptions. */
  readonly label: string;
  /** The `.epr` family that generates it; absent for a codec DGR serves only natively. */
  readonly family?: 'hevc' | 'quicktime';
  /** FourCC of the encoded video stream. */
  readonly fourcc?: string;
  /** The one chroma subsampling the codec produces. */
  readonly chroma: Chroma;
  /** Bit depths the codec produces; the first is the default when a config names none. */
  readonly bitDepths: readonly [BitDepth, ...BitDepth[]];
  /** Whether the codec carries an alpha channel. */
  readonly alpha: boolean;
  /** Whether the codec takes a target bitrate. */
  readonly bitrate: boolean;
}

/** Every codec a config can name, with what it produces. */
export const CODEC_TRAITS: Readonly<Record<Codec, CodecTraits>> = {
  h264: { label: 'H.264', chroma: '420', bitDepths: [8], alpha: false, bitrate: false },
  hevc: {
    label: 'HEVC (H.265)',
    family: 'hevc',
    fourcc: 'hvc1',
    chroma: '420',
    bitDepths: [8, 10],
    alpha: false,
    bitrate: true,
  },
  prores4444: {
    label: 'Apple ProRes 4444',
    family: 'quicktime',
    fourcc: 'ap4h',
    chroma: '444',
    bitDepths: [12],
    alpha: true,
    bitrate: false,
  },
  prores4444xq: {
    label: 'Apple ProRes 4444 XQ',
    family: 'quicktime',
    fourcc: 'ap4x',
    chroma: '444',
    bitDepths: [12],
    alpha: true,
    bitrate: false,
  },
};

/** A frame size in pixels. */
export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

/** A {@link Resolution} (`'1920x1080'` or `{ width, height }`) as a {@link FrameSize}. */
export function frameSizeOf(resolution: Resolution): FrameSize {
  if (typeof resolution !== 'string') return { width: resolution.width, height: resolution.height };
  const [width, height] = resolution.split('x').map(Number);
  return { width: width ?? Number.NaN, height: height ?? Number.NaN };
}

const BITRATE_UNIT: Readonly<Record<string, number>> = { k: 1e3, K: 1e3, m: 1e6, M: 1e6 };

/** A {@link Bitrate} in whole bits per second: `'120M'` → 120 000 000, `'2500k'` → 2 500 000. */
export function bitrateBps(bitrate: Bitrate): number {
  if (typeof bitrate === 'number') return Math.round(bitrate);
  const unit = BITRATE_UNIT[bitrate.slice(-1)];
  return Math.round(unit === undefined ? Number(bitrate) : Number(bitrate.slice(0, -1)) * unit);
}

/** Adobe Media Encoder's time base, in ticks per second. */
export const TICKS_PER_SECOND = 254_016_000_000;

/** NTSC rates as written in decimal, paired with their exact 1000/1001 values. */
const NTSC_RATES: readonly (readonly [decimal: number, exact: number])[] = [
  [23.976, 24000 / 1001],
  [29.97, 30000 / 1001],
  [47.952, 48000 / 1001],
  [59.94, 60000 / 1001],
  [119.88, 120000 / 1001],
];

/** A frame rate rounded to three decimals, so `30000 / 1001` and `29.97` compare equal. */
export function normalizeFrameRate(fps: number): number {
  return Math.round(fps * 1000) / 1000;
}

/** AME ticks per frame at `fps`, reading an NTSC decimal (`29.97`, …) as its exact 1000/1001 rate. */
export function ticksPerFrame(fps: number): number {
  const rounded = normalizeFrameRate(fps);
  const ntsc = NTSC_RATES.find(([decimal]) => decimal === rounded);
  return Math.round(TICKS_PER_SECOND / (ntsc === undefined ? fps : ntsc[1]));
}

/** The frame rate an AME tick count encodes, rounded to three decimals. */
export function frameRateOfTicks(ticks: number): number {
  return normalizeFrameRate(TICKS_PER_SECOND / ticks);
}

/**
 * A config in canonical form: the frame size as a `'WxH'` `resolution` or a
 * `matchSource` flag, every value normalized (bitrate in bits per second, frame
 * rate to three decimals), and fields equal to the codec's defaults dropped.
 * Two configs that encode the same output have the same canonical form.
 */
export type CanonicalConfig = Readonly<Record<string, string | number | boolean>>;

/** See {@link CanonicalConfig}. `config` must already have passed schema validation. */
export function canonicalConfig(config: EncodeConfig): CanonicalConfig {
  const traits = CODEC_TRAITS[config.codec];
  const out: Record<string, string | number | boolean> = { codec: config.codec };
  if (config.resolution !== undefined) {
    const { width, height } = frameSizeOf(config.resolution);
    out.resolution = `${width}x${height}`;
  } else {
    out.matchSource = config.matchSource !== false;
  }
  if (config.frameRate !== undefined) out.frameRate = normalizeFrameRate(config.frameRate);
  if (config.bitDepth !== undefined && config.bitDepth !== traits.bitDepths[0]) {
    out.bitDepth = config.bitDepth;
  }
  if (config.chroma !== undefined && config.chroma !== traits.chroma) out.chroma = config.chroma;
  if (config.alpha === true) out.alpha = true;
  if (config.bitrate !== undefined) out.bitrate = bitrateBps(config.bitrate);
  if (config.mode !== undefined) out.mode = config.mode;
  if (config.color !== undefined && config.color.toLowerCase() !== 'rec709') {
    out.color = config.color;
  }
  return out;
}

/** {@link canonicalConfig} as a key-order-independent string, for equality and hashing. */
export function canonicalKey(config: EncodeConfig): string {
  const canonical = canonicalConfig(config);
  return JSON.stringify(
    Object.keys(canonical)
      .sort()
      .map((key) => [key, canonical[key]]),
  );
}

/** An {@link AudioVideoError} with `code: 'invalid_preset'`. */
export function invalidPreset(message: string, cause?: unknown): AudioVideoError {
  return new AudioVideoError({ message, code: 'invalid_preset', cause });
}

/** A zod error's issues on one line: `codec: codec must be …; bitDepth: …`. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ');
}

/**
 * `schema.parse(value)`, with a validation failure rethrown as an
 * `invalid_preset` {@link AudioVideoError} whose message lists every issue and
 * whose `.cause` is the original zod error.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw invalidPreset(`Invalid ${what}: ${describeIssues(result.error)}`, result.error);
}
