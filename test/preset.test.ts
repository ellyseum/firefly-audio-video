import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, expect, test, vi, type Mock } from 'vitest';
import { AudioVideoError } from '../src/core/errors.js';
import { buildRenderBody } from '../src/dgr/build-body.js';
import {
  Preset,
  encode,
  presets,
  resize,
  resolvePreset,
  toPreset,
  type ResolvePresetContext,
} from '../src/dgr/preset.js';
import type { EncodeConfig } from '../src/dgr/schemas.js';
import { NAMED } from '../src/presets/catalog.js';
import { toEpr } from '../src/presets/epr.js';
import { PRESET_NAMES } from '../src/presets/names.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A file under a fresh OS temp directory, removed after the test. */
function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'firefly-audio-video-preset-'));
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, contents, 'utf8');
  return path;
}

/** The AudioVideoError `fn` throws, checked for `code`. */
function thrown(fn: () => unknown, code = 'invalid_preset'): AudioVideoError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AudioVideoError);
    expect((error as AudioVideoError).code).toBe(code);
    return error as AudioVideoError;
  }
  throw new Error(`expected an AudioVideoError (${code})`);
}

/** A resolve context whose stage() records every XML it is handed. */
function stagingContext(url = 'https://store.example/p.epr?sig=S'): ResolvePresetContext & {
  stage: Mock<(xml: string) => Promise<string>>;
} {
  return { stage: vi.fn(async (xml: string) => (xml ? url : '')) };
}

const EPR_XML = toEpr({ codec: 'prores4444xq', alpha: true, matchSource: true });

describe('immutability and the JSON surface', () => {
  test('every modifier returns a new Preset and leaves the original untouched', () => {
    const base = Preset.encode({ codec: 'hevc', resolution: '1920x1080' });
    const before = base.toJSON();
    const results = [
      base.with({ frameRate: 25 }),
      base.extend({ bitrate: '20M' }),
      base.resize('9:16'),
      base.bitDepth(10),
      base.bitrate(30_000_000),
      base.chroma('420'),
      base.alpha(false),
    ];
    for (const result of results) {
      expect(result).toBeInstanceOf(Preset);
      expect(result).not.toBe(base);
    }
    expect(new Set(results).size).toBe(results.length);
    expect(base.toJSON()).toEqual(before);

    const chained = results[2]!.bitDepth(10);
    expect(results[2]!.toJSON().config).toEqual({ codec: 'hevc', resolution: '1080x1920' });
    expect(chained.toJSON().config).toEqual({
      codec: 'hevc',
      resolution: '1080x1920',
      bitDepth: 10,
    });
  });

  test('a Preset and the config it holds cannot be mutated from outside', () => {
    const preset = Preset.encode({ codec: 'hevc', resolution: { width: 1920, height: 1080 } });
    expect(Object.isFrozen(preset)).toBe(true);
    const json = preset.toJSON();
    (json.config.resolution as { width: number }).width = 1;
    json.config.codec = 'prores4444';
    expect(preset.toJSON().config).toEqual({
      codec: 'hevc',
      resolution: { width: 1920, height: 1080 },
    });
  });

  test('toString() and util.inspect show JSON — never XML — for every kind', () => {
    const everyKind = [Preset.prores, Preset.encode({ codec: 'hevc' }), Preset.fromEpr(EPR_XML)];
    for (const preset of everyKind) {
      const text = preset.toString();
      expect(text).not.toContain('<');
      expect(JSON.parse(text)).toEqual(preset.toJSON());
      expect(inspect(preset)).not.toContain('<');
      expect(inspect(preset)).toContain(`kind: '${preset.kind}'`);
    }
    expect(JSON.parse(Preset.prores.toString())).toEqual({
      kind: 'named',
      name: 'prores',
      config: { codec: 'prores4444', alpha: true, matchSource: true },
    });
  });
});

describe('named accessors', () => {
  test('Preset.prores and new Preset().prores are the same named preset', () => {
    expect(new Preset().prores.toJSON()).toEqual(Preset.prores.toJSON());
    expect(Preset.encode({ codec: 'hevc', bitDepth: 10 }).prores.toJSON()).toEqual(
      Preset.prores.toJSON(),
    );
    for (const name of PRESET_NAMES) {
      expect(new Preset()[name].toJSON(), name).toEqual(Preset[name].toJSON());
      expect(Preset[name].kind).toBe('named');
    }
  });

  test('each read returns a fresh Preset', () => {
    expect(Preset.prores).not.toBe(Preset.prores);
    expect(presets.hevc4k10bit).not.toBe(presets.hevc4k10bit);
    expect(new Preset().prores4444xq).not.toBe(new Preset().prores4444xq);
  });

  test('presets mirrors the Preset statics, one enumerable getter per catalog name', () => {
    expect(Object.keys(presets)).toEqual([...PRESET_NAMES]);
    for (const name of PRESET_NAMES) {
      expect(presets[name].toJSON(), name).toEqual(Preset[name].toJSON());
    }
    expect(Object.isFrozen(presets)).toBe(true);
  });

  test('the catalog maps each of the sixteen native presetIds to exactly one passthrough name', () => {
    const passthrough = Object.values(NAMED).filter((entry) => entry.kind === 'passthrough');
    const ids = passthrough.map((entry) => ('presetId' in entry ? entry.presetId : ''));
    const expected = [
      ...[
        'land_1080p',
        'square_1080p',
        'vert_1920p',
        'portrait_2x3_1620p',
        'portrait_4x5_1350p',
      ].flatMap((size) => ['hq', 'lq', '2_pass'].map((tier) => `ffs_video_api_${size}_${tier}`)),
      'ffs_video_api_prores',
    ];
    expect([...ids].sort()).toEqual([...expected].sort());
    expect(Object.keys(NAMED)).toEqual([...PRESET_NAMES]);
  });

  test('no catalog name shadows a Preset member', () => {
    const methods = [
      'with',
      'extend',
      'resize',
      'bitDepth',
      'bitrate',
      'chroma',
      'alpha',
      'toJSON',
      'toString',
    ];
    const others = ['constructor', 'kind', 'encode', 'fromEpr', 'prototype', 'name', 'length'];
    for (const name of PRESET_NAMES) {
      expect(methods, name).not.toContain(name);
      expect(others, name).not.toContain(name);
    }
    for (const method of methods) {
      expect(typeof Object.getOwnPropertyDescriptor(Preset.prototype, method)?.value, method).toBe(
        'function',
      );
    }
    expect(typeof Object.getOwnPropertyDescriptor(Preset.prototype, 'kind')?.get).toBe('function');
  });
});

describe('building from a config', () => {
  test('the JSON constructor validates and keeps the config; no argument gives an empty base', () => {
    const preset = new Preset({ codec: 'hevc', bitDepth: 10, resolution: '3840x2160' });
    expect(preset.kind).toBe('config');
    expect(preset.toJSON()).toEqual({
      kind: 'config',
      config: { codec: 'hevc', bitDepth: 10, resolution: '3840x2160' },
    });
    expect(new Preset().toJSON()).toEqual({ kind: 'config', config: {} });
    expect(new Preset().with({ codec: 'prores4444' }).toJSON().config).toEqual({
      codec: 'prores4444',
    });
  });

  test('encode and resize are the functional forms', () => {
    expect(encode({ codec: 'prores4444xq' }).toJSON()).toEqual(
      Preset.encode({ codec: 'prores4444xq' }).toJSON(),
    );
    expect(resize('9:16').toJSON()).toEqual({
      kind: 'config',
      config: { resolution: '1080x1920' },
    });
  });

  test('with() merges; a resolution replaces matchSource; undefined removes a field', () => {
    const sized = Preset.prores4444xq.with({ resolution: '1920x1080' });
    expect(sized.toJSON().config).toEqual({
      codec: 'prores4444xq',
      alpha: true,
      resolution: '1920x1080',
    });
    expect(sized.with({ matchSource: true }).toJSON().config).toEqual({
      codec: 'prores4444xq',
      alpha: true,
      matchSource: true,
    });
    expect(sized.with({ alpha: undefined }).toJSON().config).toEqual({
      codec: 'prores4444xq',
      resolution: '1920x1080',
    });
  });

  test("resize maps DGR's aspect ladder, accepts WxH, and rejects anything else", () => {
    const hevc = Preset.encode({ codec: 'hevc' });
    expect(hevc.resize('16:9').toJSON().config.resolution).toBe('1920x1080');
    expect(hevc.resize('1:1').toJSON().config.resolution).toBe('1080x1080');
    expect(hevc.resize('9:16').toJSON().config.resolution).toBe('1080x1920');
    expect(hevc.resize('2:3').toJSON().config.resolution).toBe('1080x1620');
    expect(hevc.resize('4:5').toJSON().config.resolution).toBe('1080x1350');
    expect(hevc.resize('1280x720').toJSON().config.resolution).toBe('1280x720');
    const error = thrown(() => hevc.resize('3:1' as never));
    expect(error.message).toContain("'16:9', '1:1', '9:16', '2:3', '4:5'");
  });

  test("chroma('420') is accepted and an unknown chroma is rejected", () => {
    expect(Preset.encode({ codec: 'hevc' }).chroma('420').toJSON().config.chroma).toBe('420');
    expect(new Preset({ codec: 'hevc', chroma: '420' }).toJSON().config.chroma).toBe('420');
    expect(thrown(() => Preset.encode({ codec: 'hevc' }).chroma('411' as never)).message).toContain(
      "chroma must be '420', '422' or '444'",
    );
  });

  test('an unknown codec is rejected with a message listing the valid codecs', () => {
    const error = thrown(() => new Preset({ codec: 'h265' } as unknown as EncodeConfig));
    expect(error.message).toContain(
      "codec must be one of 'h264', 'hevc', 'prores4444' or 'prores4444xq'",
    );
    expect(error.message).toContain('"h265"');
    expect(thrown(() => Preset.prores.with({ codec: 'vp9' } as never)).message).toContain(
      'codec must be one of',
    );
    expect(thrown(() => new Preset({} as unknown as EncodeConfig)).message).toContain(
      'codec is required',
    );
  });

  test('a codec-less preset explains where the codec should come from', async () => {
    const direct = thrown(() => new Preset({} as unknown as EncodeConfig)).message;
    expect(direct).toContain('empty base, resize(), or a URL-loaded .epr');
    expect(direct).toContain('.with({ codec })');

    await expect(resolvePreset(resize('9:16'), stagingContext())).rejects.toMatchObject({
      code: 'invalid_preset',
      message: expect.stringContaining('empty base, resize(), or a URL-loaded .epr'),
    });
  });

  test('modifier values are validated', () => {
    const hevc = Preset.encode({ codec: 'hevc' });
    expect(thrown(() => hevc.bitDepth(9 as never)).message).toContain(
      'bitDepth must be 8, 10 or 12',
    );
    expect(thrown(() => hevc.bitrate('fast')).message).toContain("such as '120M'");
    expect(thrown(() => hevc.bitrate(-5)).message).toContain('bitrate must be a positive number');
    expect(thrown(() => hevc.alpha('yes' as never)).message).toContain('alpha');
    expect(thrown(() => hevc.with({ fps: 30 } as never)).message).toContain('Unrecognized key');
  });

  test('oversized input echoed into a message is bounded', () => {
    const bigCodec = thrown(() => new Preset({ codec: 'x'.repeat(20_000) } as never)).message;
    expect(bigCodec.length).toBeLessThan(300);
    expect(bigCodec).toContain('codec must be one of');

    const bigResize = thrown(() =>
      Preset.encode({ codec: 'hevc' }).resize('x'.repeat(20_000) as never),
    ).message;
    expect(bigResize.length).toBeLessThan(300);
    expect(bigResize).toContain('resize target must be one of');
  });
});

describe('toPreset', () => {
  test('passes a Preset through and builds one from a config object', () => {
    const preset = Preset.prores;
    expect(toPreset(preset)).toBe(preset);
    expect(toPreset({ codec: 'hevc', bitDepth: 10 }).toJSON()).toEqual({
      kind: 'config',
      config: { codec: 'hevc', bitDepth: 10 },
    });
  });

  test('resolves a catalog name and a native presetId to the named preset', () => {
    expect(toPreset('hevc1080p10bit').toJSON()).toEqual(Preset.hevc1080p10bit.toJSON());
    expect(toPreset('ffs_video_api_vert_1920p_hq').toJSON()).toEqual(
      Preset.h264Vert1920pHq.toJSON(),
    );
    expect(toPreset(' ffs_video_api_prores ').toJSON()).toEqual(Preset.prores.toJSON());
  });

  test('loads raw XML, an http(s) URL, a .epr path, and an existing file as .epr presets', () => {
    expect(toPreset(EPR_XML).kind).toBe('epr');
    expect(toPreset(`  ${EPR_XML}`).kind).toBe('epr');
    expect(toPreset('https://store.example/custom.epr?sig=S').kind).toBe('epr');
    expect(toPreset(tempFile('custom.epr', EPR_XML)).kind).toBe('epr');
    expect(toPreset(tempFile('custom-preset', EPR_XML)).toJSON().config.codec).toBe('prores4444xq');
  });

  test('rejects anything else with invalid_preset, naming the valid presets', () => {
    const error = thrown(() => toPreset('proress'));
    expect(error.message).toContain('Unknown preset "proress"');
    expect(error.message).toContain('prores4444xq');
    expect(error.message).toContain('h264Land1080pHq');
    expect(thrown(() => toPreset(42 as never)).message).toContain('of type number');
    expect(thrown(() => toPreset(null as never)).message).toContain('of type null');
    expect(thrown(() => toPreset(join(tmpdir(), 'no-such-dir', 'missing.epr'))).message).toContain(
      'Could not read',
    );
  });

  test("a Preset's own JSON form names itself rather than failing as a bare config", () => {
    const error = thrown(() => toPreset(Preset.prores.toJSON() as never));
    expect(error.message).toContain("Preset's JSON form");
    expect(error.message).not.toContain('Unrecognized keys');
  });
});

describe('Preset.fromEpr', () => {
  test("reads a real .epr's headline fields into the JSON view", () => {
    expect(Preset.fromEpr(EPR_XML).toJSON()).toEqual({
      kind: 'epr',
      config: {
        codec: 'prores4444xq',
        matchSource: true,
        chroma: '444',
        bitDepth: 12,
        alpha: true,
      },
    });
    expect(Preset.fromEpr(tempFile('a.epr', EPR_XML)).toJSON().config.codec).toBe('prores4444xq');
    expect(Preset.fromEpr('https://store.example/a.epr').toJSON()).toEqual({
      kind: 'epr',
      config: {},
    });
  });

  test('modifying a loaded .epr switches to a generated preset built from its headline', () => {
    const tweaked = Preset.fromEpr(EPR_XML).resize('1920x1080');
    expect(tweaked.kind).toBe('config');
    expect(tweaked.toJSON().config).toEqual({
      codec: 'prores4444xq',
      chroma: '444',
      bitDepth: 12,
      alpha: true,
      resolution: '1920x1080',
    });
  });

  test('rejects empty input, unreadable paths, and content that is not an .epr', () => {
    expect(thrown(() => Preset.fromEpr('  ')).message).toContain('Preset.fromEpr expects');
    expect(thrown(() => Preset.fromEpr(tempFile('notes.epr', 'hello'))).message).toContain(
      'no <PremiereData> element',
    );
    expect(thrown(() => Preset.fromEpr('<?xml version="1.0"?><other/>')).message).toContain(
      'The XML is not an Adobe Media Encoder preset',
    );
  });

  test('an oversized non-.epr string is bounded in the "could not read" message', () => {
    const big = 'y'.repeat(20_000);
    const message = thrown(() => Preset.fromEpr(big)).message;
    expect(message.length).toBeLessThan(300);
    expect(message).toContain('Could not read the .epr file at');
  });
});

describe('resolvePreset', () => {
  test('a named passthrough preset resolves to its presetId without staging', async () => {
    const ctx = stagingContext();
    expect(await resolvePreset(Preset.prores, ctx)).toEqual({ presetId: 'ffs_video_api_prores' });
    expect(await resolvePreset(Preset.h264Square1080p2Pass, ctx)).toEqual({
      presetId: 'ffs_video_api_square_1080p_2_pass',
    });
    expect(ctx.stage).not.toHaveBeenCalled();
  });

  test('a config exactly matching a native preset resolves to that presetId without staging', async () => {
    const ctx = stagingContext();
    const config: EncodeConfig = { codec: 'prores4444', alpha: true, matchSource: true };
    expect(await resolvePreset(Preset.encode(config), ctx)).toEqual({
      presetId: 'ffs_video_api_prores',
    });
    expect(
      await resolvePreset(Preset.encode({ codec: 'prores4444', alpha: true, chroma: '444' }), ctx),
    ).toEqual({ presetId: 'ffs_video_api_prores' });
    expect(await resolvePreset(presets.h264Land1080pLq.resize('9:16'), ctx)).toEqual({
      presetId: 'ffs_video_api_vert_1920p_lq',
    });
    expect(ctx.stage).not.toHaveBeenCalled();
  });

  test('a config one field away from a native preset does not resolve to it', async () => {
    const ctx = stagingContext();
    const withoutAlpha = await resolvePreset(Preset.encode({ codec: 'prores4444' }), ctx);
    const fixedSize = await resolvePreset(Preset.prores.resize('16:9'), ctx);
    const otherCodec = await resolvePreset(Preset.prores.with({ codec: 'prores4444xq' }), ctx);
    for (const ref of [withoutAlpha, fixedSize, otherCodec]) {
      expect(ref).toEqual({ url: 'https://store.example/p.epr?sig=S' });
    }
    expect(ctx.stage).toHaveBeenCalledTimes(3);
    expect(await resolvePreset(Preset.h264Land1080pHq.with({ mode: 'lq' }), ctx)).toEqual({
      presetId: 'ffs_video_api_land_1080p_lq',
    });
    await expect(resolvePreset(Preset.h264Land1080pHq.bitrate('12M'), ctx)).rejects.toMatchObject({
      code: 'invalid_preset',
    });
  });

  test('an unmatched config stages its generated .epr once and resolves to the staged URL', async () => {
    const ctx = stagingContext();
    expect(await resolvePreset(Preset.hevc1080p10bit, ctx)).toEqual({
      url: 'https://store.example/p.epr?sig=S',
    });
    expect(ctx.stage).toHaveBeenCalledTimes(1);
    const xml = ctx.stage.mock.calls[0]![0];
    expect(xml).toContain('4A454646_48455643');
    expect(xml).toBe(
      toEpr({ codec: 'hevc', bitDepth: 10, chroma: '420', resolution: '1920x1080' }),
    );

    const prores = stagingContext();
    await resolvePreset(Preset.prores.resize('9:16'), prores);
    expect(prores.stage).toHaveBeenCalledTimes(1);
    expect(prores.stage.mock.calls[0]![0]).toContain('3F3F3F3F_4D6F6F56');
  });

  test('an .epr preset resolves to its URL as-is, or stages its XML verbatim', async () => {
    const ctx = stagingContext();
    expect(await resolvePreset(Preset.fromEpr('https://store.example/a.epr?sig=A'), ctx)).toEqual({
      url: 'https://store.example/a.epr?sig=A',
    });
    expect(ctx.stage).not.toHaveBeenCalled();

    const raw = `\n${EPR_XML}`;
    expect(await resolvePreset(Preset.fromEpr(raw), ctx)).toEqual({
      url: 'https://store.example/p.epr?sig=S',
    });
    expect(ctx.stage).toHaveBeenCalledWith(raw);
  });

  test('a custom matchNamed decides native matches', async () => {
    const ctx = { ...stagingContext(), matchNamed: vi.fn(() => 'custom_native_id') };
    expect(await resolvePreset(Preset.hevc4k10bit, ctx)).toEqual({ presetId: 'custom_native_id' });
    expect(ctx.matchNamed).toHaveBeenCalledWith({
      codec: 'hevc',
      bitDepth: 10,
      chroma: '420',
      resolution: '3840x2160',
    });
    expect(ctx.stage).not.toHaveBeenCalled();
  });

  test('rejects what cannot render with a typed error', async () => {
    const ctx = stagingContext();
    await expect(resolvePreset(new Preset(), ctx)).rejects.toMatchObject({
      code: 'invalid_preset',
      message: expect.stringContaining('codec is required'),
    });
    await expect(
      resolvePreset(Preset.h264Land1080pHq.with({ frameRate: 60 }), ctx),
    ).rejects.toMatchObject({
      code: 'invalid_preset',
      message: expect.stringContaining('native presets'),
    });
    await expect(resolvePreset({} as Preset, ctx)).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    await expect(
      resolvePreset(Preset.hevc4k10bit, { stage: async () => '' }),
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('stage()'),
    });
    await expect(
      resolvePreset(Preset.hevc4k10bit, {} as ResolvePresetContext),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(
      resolvePreset(Preset.hevc4k10bit, undefined as unknown as ResolvePresetContext),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  test('its result pipes through buildRenderBody wrapped in source', async () => {
    const ctx = stagingContext();
    const named = await resolvePreset(Preset.prores, ctx);
    const staged = await resolvePreset(Preset.hevc4k10bit, ctx);
    const body = buildRenderBody({
      source: 'https://store.example/capsule.mogrt?sig=C',
      presets: [named, staged],
      outputs: [
        { presetIndex: 0, destination: 'https://store.example/a.mov?sig=D' },
        { presetIndex: 1, destination: 'https://store.example/b.mp4?sig=E' },
      ],
    });
    expect(body.presets[0]).toEqual({ source: { presetId: 'ffs_video_api_prores' } });
    expect(body.presets[1]).toEqual({ source: { url: 'https://store.example/p.epr?sig=S' } });
  });
});

describe('typed accessors', () => {
  test('unknown names do not type-check', () => {
    // @ts-expect-error a name outside the catalog is a compile error
    expect(Preset.notAPreset).toBeUndefined();
    // @ts-expect-error a name outside the catalog is a compile error on instances too
    expect(new Preset().notAPreset).toBeUndefined();
    const chained: Preset = Preset.hevc4k10bit.resize('9:16').bitDepth(10).prores;
    expect(chained.kind).toBe('named');
  });
});
