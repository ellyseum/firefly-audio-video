import { describe, expect, test } from 'vitest';
import { AudioVideoError } from '../src/core/errors.js';
import type { EncodeConfig } from '../src/dgr/schemas.js';
import {
  bitrateBps,
  canonicalConfig,
  frameRateOfTicks,
  ticksPerFrame,
} from '../src/presets/codecs.js';
import { HEVC_BASE_EPR } from '../src/presets/epr-templates/hevc.js';
import { QUICKTIME_BASE_EPR } from '../src/presets/epr-templates/quicktime.js';
import {
  EXPORTER_FOLDERS,
  exporterFolder,
  fourccOf,
  fourccValue,
  parseEprHeadline,
  toEpr,
} from '../src/presets/epr.js';

/** The one `<ExporterParam>` block whose ParamIdentifier is `id`; fails the test unless exactly one exists. */
function block(xml: string, id: string): string {
  const blocks = xml.match(/<ExporterParam ObjectID="\d+"[^>]*>[\s\S]*?<\/ExporterParam>/g) ?? [];
  const matching = blocks.filter((b) => b.includes(`<ParamIdentifier>${id}</ParamIdentifier>`));
  expect(matching, `${id} parameters`).toHaveLength(1);
  return matching[0]!;
}

/** The text of `tag` inside parameter `id`. */
function value(xml: string, id: string, tag = 'ParamValue'): string | undefined {
  return new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block(xml, id))?.[1];
}

/** The match-source payload of an `.epr`. */
function matchSource(xml: string): { data: string; checksum: string } {
  const found = /<ParamArbData Encoding="base64" Checksum="(\d+)">([^<]*)<\/ParamArbData>/.exec(
    block(xml, 'ADBEVideoMatchSource'),
  );
  return { checksum: found?.[1] ?? '', data: found?.[2] ?? '' };
}

/** Whether parameter `id` is flagged disabled. */
function disabled(xml: string, id: string): boolean {
  return block(xml, id).includes('<ParamIsDisabled>true</ParamIsDisabled>');
}

/** The exporter folder an `.epr` declares through its ExporterClassID and ExporterFileType. */
function folderOf(xml: string): string {
  const classId = Number(/<ExporterClassID>(\d+)<\/ExporterClassID>/.exec(xml)?.[1]);
  const fileType = Number(/<ExporterFileType>(\d+)<\/ExporterFileType>/.exec(xml)?.[1]);
  return exporterFolder(classId, fileType);
}

/** The FourCC the video codec parameter spells. */
function codecFourcc(xml: string): string {
  return fourccOf(Number(value(xml, 'ADBEVideoCodec')));
}

/** The text of a top-level element. */
function topLevel(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];
}

/** The invalid_preset error `fn` throws. */
function presetError(fn: () => unknown): AudioVideoError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AudioVideoError);
    expect((error as AudioVideoError).code).toBe('invalid_preset');
    return error as AudioVideoError;
  }
  throw new Error('expected an invalid_preset error');
}

const PRORES_XQ: EncodeConfig = { codec: 'prores4444xq', alpha: true, matchSource: true };
const HEVC_1080P_10: EncodeConfig = {
  codec: 'hevc',
  bitDepth: 10,
  chroma: '420',
  resolution: '1920x1080',
};

describe('codec family markers', () => {
  test('toEpr(prores4444xq) carries the QuickTime exporter folder and the ap4x FourCC', () => {
    const xml = toEpr(PRORES_XQ);
    expect(xml).toContain('3F3F3F3F_4D6F6F56');
    expect(xml).toContain('ap4x');
    expect(folderOf(xml)).toBe(EXPORTER_FOLDERS.quicktime);
    expect(codecFourcc(xml)).toBe('ap4x');
  });

  test('toEpr(prores4444) keeps the QuickTime exporter and switches the video codec to ap4h', () => {
    const xml = toEpr({ codec: 'prores4444' });
    expect(folderOf(xml)).toBe('3F3F3F3F_4D6F6F56');
    expect(codecFourcc(xml)).toBe('ap4h');
    expect(xml).toContain('ap4h');
  });

  test('toEpr(hevc) carries the HEVC exporter folder and names the hvc1 FourCC', () => {
    const xml = toEpr(HEVC_1080P_10);
    expect(xml).toContain('4A454646_48455643');
    expect(xml).toContain('hvc1');
    expect(folderOf(xml)).toBe(EXPORTER_FOLDERS.hevc);
    expect(codecFourcc(xml)).toBe('HEVC');
  });
});

describe('patched fields', () => {
  test('a fixed frame size lands in the width and height parameters', () => {
    const hevc = toEpr({ codec: 'hevc', resolution: '3840x2160' });
    expect(value(hevc, 'ADBEVideoWidth')).toBe('3840');
    expect(value(hevc, 'ADBEVideoHeight')).toBe('2160');
    expect(disabled(hevc, 'ADBEVideoWidth')).toBe(false);

    const prores = toEpr({ codec: 'prores4444', resolution: { width: 1080, height: 1920 } });
    expect(value(prores, 'ADBEVideoWidth')).toBe('1080');
    expect(value(prores, 'ADBEVideoHeight')).toBe('1920');
  });

  test('a fixed frame size without a frame rate lets the frame rate follow the source', () => {
    const hevc = toEpr({ codec: 'hevc', resolution: '1920x1080' });
    expect(matchSource(hevc)).toEqual({ data: 'BAAAAA==', checksum: '2492304781' });
    expect(disabled(hevc, 'ADBEVideoFPS')).toBe(true);

    const prores = toEpr({ codec: 'prores4444xq', resolution: '1920x1080' });
    expect(matchSource(prores)).toEqual({ data: 'DAAAAA==', checksum: '2794294669' });
  });

  test('a fixed frame rate sets the tick count and stops anything following the source', () => {
    const hevc = toEpr({ codec: 'hevc', resolution: '1920x1080', frameRate: 29.97 });
    expect(value(hevc, 'ADBEVideoFPS')).toBe('8475667200');
    expect(disabled(hevc, 'ADBEVideoFPS')).toBe(false);
    expect(matchSource(hevc)).toEqual({ data: 'AAAAAA==', checksum: '2374864269' });

    const prores = toEpr({ codec: 'prores4444', resolution: '1920x1080', frameRate: 24 });
    expect(value(prores, 'ADBEVideoFPS')).toBe('10584000000');
    expect(matchSource(prores)).toEqual({ data: 'AAAAAA==', checksum: '2374864269' });
  });

  test('without a resolution the frame size follows the source', () => {
    const hevc = toEpr({ codec: 'hevc' });
    expect(matchSource(hevc)).toEqual({ data: 'fwAAAA==', checksum: '546147725' });
    for (const id of [
      'ADBEVideoWidth',
      'ADBEVideoHeight',
      'ADBEVideoFPS',
      'ADBEVideoAspect',
      'ADBEVideoMPEGProfile',
      'ADBEVideoMPEGProfileLevel',
    ]) {
      expect(disabled(hevc, id), id).toBe(true);
    }
    expect(disabled(hevc, 'ADBEVideoFieldType')).toBe(false);

    const prores = toEpr({ codec: 'prores4444', matchSource: true });
    expect(matchSource(prores)).toEqual({ data: 'HQAAAA==', checksum: '1418562957' });
  });

  test('bitDepth selects the HEVC profile: 10 is Main10, 8 is Main', () => {
    expect(value(toEpr(HEVC_1080P_10), 'ADBEVideoMPEGProfile')).toBe('2');
    expect(value(toEpr({ ...HEVC_1080P_10, bitDepth: 8 }), 'ADBEVideoMPEGProfile')).toBe('1');
    expect(value(toEpr({ codec: 'hevc', resolution: '1920x1080' }), 'ADBEVideoMPEGProfile')).toBe(
      '1',
    );
  });

  test('alpha selects the ProRes depth: 5 with alpha, 4 without', () => {
    expect(value(toEpr(PRORES_XQ), 'ADBEVideoBitDepth')).toBe('5');
    expect(value(toEpr({ ...PRORES_XQ, alpha: false }), 'ADBEVideoBitDepth')).toBe('4');
    expect(value(toEpr({ codec: 'prores4444' }), 'ADBEVideoBitDepth')).toBe('4');
  });

  test("an HEVC frame size takes AME's default rates for that size and the lowest level admitting them", () => {
    const uhd = toEpr({ codec: 'hevc', resolution: '3840x2160' });
    expect(value(uhd, 'ADBEVideoTargetBitrate')).toBe('35.');
    expect(value(uhd, 'ADBEVideoMaxBitrate')).toBe('40.');
    expect(value(uhd, 'ADBEVideoTargetBitrate', 'ParamMaxValue')).toBe('40.');
    expect(value(uhd, 'ADBEVideoMPEGProfileLevel')).toBe('51');

    const sd = toEpr({ codec: 'hevc', resolution: '640x480' });
    expect(value(sd, 'ADBEVideoTargetBitrate')).toBe('1.300000000000000044408921');
    expect(value(sd, 'ADBEVideoMaxBitrate')).toBe('1.800000000000000044408921');
  });

  test('a bitrate sets the target, a 1.25x maximum, and a level that admits the maximum', () => {
    const xml = toEpr({ codec: 'hevc', resolution: '1920x1080', bitrate: '40M' });
    expect(value(xml, 'ADBEVideoTargetBitrate')).toBe('40.');
    expect(value(xml, 'ADBEVideoMaxBitrate')).toBe('50.');
    expect(value(xml, 'ADBEVideoMPEGProfileLevel')).toBe('52');
    expect(value(xml, 'ADBEVideoMaxBitrate', 'ParamMaxValue')).toBe('60.');

    const kilobits = toEpr({ codec: 'hevc', resolution: '1920x1080', bitrate: '2500k' });
    expect(value(kilobits, 'ADBEVideoTargetBitrate')).toBe('2.5');
    expect(value(kilobits, 'ADBEVideoMPEGProfileLevel')).toBe('41');
  });

  test('a source-sized HEVC preset keeps the template rates unless a bitrate is given', () => {
    const plain = toEpr({ codec: 'hevc' });
    expect(value(plain, 'ADBEVideoTargetBitrate')).toBe('16.');
    expect(value(plain, 'ADBEVideoMaxBitrate')).toBe('20.');

    const rated = toEpr({ codec: 'hevc', bitrate: 50_000_000 });
    expect(value(rated, 'ADBEVideoTargetBitrate')).toBe('50.');
    expect(value(rated, 'ADBEVideoMaxBitrate')).toBe('62.5');
    expect(value(rated, 'ADBEVideoMPEGProfileLevel')).toBe('62');
  });
});

describe('output shape', () => {
  test('is AME-shaped XML with CRLF line endings throughout', () => {
    for (const xml of [toEpr(PRORES_XQ), toEpr(HEVC_1080P_10)]) {
      expect(
        xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\r\n<PremiereData Version="3">'),
      ).toBe(true);
      expect(xml.endsWith('</PremiereData>\r\n')).toBe(true);
      expect(xml.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    }
  });

  test('is deterministic, and equivalent spellings of a config yield identical XML', () => {
    expect(toEpr(HEVC_1080P_10)).toBe(toEpr(HEVC_1080P_10));
    const spelled = toEpr({ codec: 'hevc', resolution: '1920x1080', bitrate: '120M' });
    expect(
      toEpr({ codec: 'hevc', resolution: { width: 1920, height: 1080 }, bitrate: 120_000_000 }),
    ).toBe(spelled);
    expect(toEpr({ codec: 'hevc', resolution: '1920x1080', bitrate: '120000k' })).toBe(spelled);
  });

  test('gives every generated preset its own name, description and a stable RFC 9562 v8 PresetID', () => {
    const xml = toEpr(HEVC_1080P_10);
    const id = topLevel(xml, 'PresetID');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).not.toBe(topLevel(HEVC_BASE_EPR, 'PresetID'));
    expect(topLevel(toEpr({ ...HEVC_1080P_10, bitDepth: 8 }), 'PresetID')).not.toBe(id);
    expect(topLevel(xml, 'PresetName')).toBe('HEVC (H.265) 1920x1080 10-bit');
    expect(topLevel(xml, 'PresetComments')).toContain('Main10');
    expect(topLevel(toEpr(PRORES_XQ), 'PresetName')).toBe('Apple ProRes 4444 XQ with alpha');
  });
});

describe('what a codec cannot produce', () => {
  const cases: [string, EncodeConfig, RegExp][] = [
    ['h264 has no generated .epr', { codec: 'h264', resolution: '1920x1080' }, /native presets/],
    ['4:4:4 HEVC', { codec: 'hevc', chroma: '444', resolution: '1920x1080' }, /chroma '420' only/],
    ['4:2:2 ProRes 4444', { codec: 'prores4444', chroma: '422' }, /chroma '444' only/],
    ['12-bit HEVC', { codec: 'hevc', bitDepth: 12, resolution: '1920x1080' }, /bitDepth 8 or 10/],
    ['10-bit ProRes 4444', { codec: 'prores4444xq', bitDepth: 10 }, /bitDepth 12; got 10/],
    ['HEVC alpha', { codec: 'hevc', alpha: true, resolution: '1920x1080' }, /no alpha channel/],
    ['ProRes bitrate', { codec: 'prores4444', bitrate: '120M' }, /fixed data rate/],
    [
      'a mode on HEVC',
      { codec: 'hevc', mode: 'hq', resolution: '1920x1080' },
      /set bitrate instead/,
    ],
    ['HDR color', { codec: 'hevc', color: 'pq', resolution: '1920x1080' }, /Rec\. 709/],
    ['matchSource: false alone', { codec: 'hevc', matchSource: false }, /needs a resolution/],
    [
      'a frame rate at source size',
      { codec: 'prores4444', frameRate: 30 },
      /frameRate needs a resolution/,
    ],
    [
      'HEVC bit depth at source size',
      { codec: 'hevc', bitDepth: 10 },
      /set a resolution to fix bitDepth/,
    ],
    ['an odd HEVC frame size', { codec: 'hevc', resolution: '1921x1080' }, /even frame size/],
    [
      'an out-of-range frame rate',
      { codec: 'hevc', resolution: '1920x1080', frameRate: 480 },
      /between 1 and 240/,
    ],
    [
      'an HEVC bitrate above level 6.2',
      { codec: 'hevc', resolution: '1920x1080', bitrate: '300M' },
      /192k and 240M/,
    ],
    [
      'an unknown codec',
      { codec: 'vp9' } as unknown as EncodeConfig,
      /codec must be one of 'h264', 'hevc', 'prores4444' or 'prores4444xq'/,
    ],
  ];
  test.each(cases)('rejects %s with invalid_preset', (_label, config, message) => {
    expect(presetError(() => toEpr(config)).message).toMatch(message);
  });
});

describe('the H.264 rejection message', () => {
  const deviations: [string, EncodeConfig, RegExp][] = [
    [
      'a bitrate',
      { codec: 'h264', resolution: '1920x1080', mode: 'hq', bitrate: '12M' },
      /bitrate is not settable for H\.264/,
    ],
    [
      'alpha',
      { codec: 'h264', resolution: '1920x1080', mode: 'hq', alpha: true },
      /alpha is not available for H\.264/,
    ],
    [
      'no mode',
      { codec: 'h264', resolution: '1920x1080' },
      /mode is required: 'hq' \| 'lq' \| '2pass'/,
    ],
    [
      'a non-native size',
      { codec: 'h264', resolution: '1234x567', mode: 'hq' },
      /size 1234x567 is not a native H\.264 size/,
    ],
  ];

  test.each(deviations)(
    'names %s and lists the native ladder, under 500 characters',
    (_label, config, fragment) => {
      const message = presetError(() => toEpr(config)).message;
      expect(message).toMatch(fragment);
      expect(message).toContain('native presets');
      expect(message).toContain("'hq', 'lq', '2pass'");
      expect(message.length).toBeLessThan(500);
    },
  );

  test('each deviation gets its own message', () => {
    const messages = deviations.map(([, config]) => presetError(() => toEpr(config)).message);
    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe('parseEprHeadline', () => {
  test("reads the embedded AME presets' headline fields", () => {
    expect(parseEprHeadline(HEVC_BASE_EPR)).toEqual({
      codec: 'hevc',
      resolution: '1920x1080',
      chroma: '420',
      bitDepth: 8,
      bitrate: '16M',
    });
    expect(parseEprHeadline(QUICKTIME_BASE_EPR)).toEqual({
      codec: 'prores4444xq',
      matchSource: true,
      chroma: '444',
      bitDepth: 12,
      alpha: false,
    });
  });

  test('round-trips every field a generated preset was built from', () => {
    const configs: EncodeConfig[] = [
      PRORES_XQ,
      HEVC_1080P_10,
      { codec: 'prores4444', alpha: true, resolution: '1080x1920', frameRate: 29.97 },
      { codec: 'prores4444xq', resolution: '3840x2160' },
      { codec: 'hevc', resolution: '3840x2160', frameRate: 59.94, bitrate: '45M' },
      { codec: 'hevc', resolution: '1280x720', bitDepth: 8 },
      { codec: 'hevc', bitrate: '8M' },
    ];
    for (const config of configs) {
      const parsed = parseEprHeadline(toEpr(config)) as EncodeConfig;
      expect(canonicalConfig(parsed), JSON.stringify(config)).toMatchObject(
        canonicalConfig(config),
      );
    }
  });

  test('is best-effort: anything that is not an .epr yields {}, and nothing throws', () => {
    expect(parseEprHeadline('')).toEqual({});
    expect(parseEprHeadline('not xml at all')).toEqual({});
    expect(parseEprHeadline('<?xml version="1.0"?><other/>')).toEqual({});
    expect(() => parseEprHeadline(HEVC_BASE_EPR.slice(0, 5000))).not.toThrow();
    expect(parseEprHeadline(42 as unknown as string)).toEqual({});
  });
});

describe('templates and helpers', () => {
  test('every parameter the serializer patches appears exactly once in its template', () => {
    for (const id of [
      'ADBEVideoMatchSource',
      'ADBEVideoWidth',
      'ADBEVideoHeight',
      'ADBEVideoFPS',
      'ADBEVideoAspect',
      'ADBEVideoMPEGProfile',
      'ADBEVideoMPEGProfileLevel',
      'ADBEVideoTargetBitrate',
      'ADBEVideoMaxBitrate',
    ]) {
      block(HEVC_BASE_EPR, id);
    }
    for (const id of [
      'ADBEVideoCodec',
      'ADBEVideoMatchSource',
      'ADBEVideoWidth',
      'ADBEVideoHeight',
      'ADBEVideoFPS',
      'ADBEVideoBitDepth',
    ]) {
      block(QUICKTIME_BASE_EPR, id);
    }
  });

  test('FourCC, exporter-folder, tick and bitrate conversions', () => {
    expect(fourccValue('ap4x')).toBe(1634743416);
    expect(fourccValue('ap4h')).toBe(1634743400);
    expect(fourccOf(1212503619)).toBe('HEVC');
    expect(exporterFolder(1246053958, 1212503619)).toBe('4A454646_48455643');
    expect(exporterFolder(1061109567, 1299148630)).toBe('3F3F3F3F_4D6F6F56');
    expect(ticksPerFrame(25)).toBe(10160640000);
    expect(ticksPerFrame(29.97)).toBe(8475667200);
    expect(ticksPerFrame(30000 / 1001)).toBe(8475667200);
    expect(ticksPerFrame(23.976)).toBe(10594584000);
    expect(frameRateOfTicks(8475667200)).toBe(29.97);
    expect(bitrateBps('120M')).toBe(120_000_000);
    expect(bitrateBps('2500k')).toBe(2_500_000);
    expect(bitrateBps(8_000_000)).toBe(8_000_000);
  });
});
