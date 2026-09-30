import { expect, test } from 'vitest';
import * as z from 'zod';
import { WireVariationsSchema, buildRenderBody } from '../src/dgr/build-body.js';
import type { RenderSpec } from '../src/dgr/schemas.js';

test('destination becomes an object {url}, not a string', () => {
  const body = buildRenderBody({
    source: 'https://x/cap.mogrt?sig=A',
    presets: [{ url: 'https://x/p.epr?sig=B' }],
    outputs: [{ presetIndex: 0, fileName: 'out.mov', destination: 'https://x/dst?sig=C' }],
  });
  expect(body.outputs[0]!.destination).toEqual({ url: 'https://x/dst?sig=C' });
  expect(body.source).toEqual({ url: 'https://x/cap.mogrt?sig=A' });
  expect(body.presets[0]).toEqual({ source: { url: 'https://x/p.epr?sig=B' } });
});

test('a named preset ref is wrapped as { source: { presetId } } on the wire', () => {
  const body = buildRenderBody({
    source: 's',
    presets: [{ presetId: 'ffs_video_api_prores' }],
    outputs: [{ presetIndex: 0, destination: 'd' }],
  });
  expect(body.presets[0]).toEqual({ source: { presetId: 'ffs_video_api_prores' } });
});

test('variationIndex defaults to 0; fileName omitted when absent', () => {
  const body = buildRenderBody({
    source: 's',
    presets: [{ presetId: 'p' }],
    outputs: [{ presetIndex: 0, destination: 'd' }],
  });
  expect(body.outputs[0]!.variationIndex).toBe(0);
  expect('fileName' in body.outputs[0]!).toBe(false);
});

test('a spec with no presets, and nothing else wrong, throws a zod error saying so', () => {
  const spec: RenderSpec = {
    source: 's',
    presets: [],
    outputs: [{ presetIndex: 0, destination: 'd' }],
  };
  expect(() => buildRenderBody(spec)).toThrow(z.ZodError);
  expect(() => buildRenderBody(spec)).toThrow('at least one preset is required');
});

test('a spec with no outputs, and nothing else wrong, throws a zod error saying so', () => {
  const spec: RenderSpec = { source: 's', presets: [{ presetId: 'p' }], outputs: [] };
  expect(() => buildRenderBody(spec)).toThrow(z.ZodError);
  expect(() => buildRenderBody(spec)).toThrow('at least one output is required');
});

test('an assetIndex past the end of assets throws a zod error naming exactly that variable', () => {
  let thrown: unknown;
  try {
    buildRenderBody({
      source: 's',
      presets: [{ presetId: 'p' }],
      assets: ['https://x/a0.png'],
      variations: [
        {
          variables: [
            { variableId: '0_0_media', assetIndex: 0 },
            { variableId: '0_1_media', assetIndex: 1 },
          ],
        },
      ],
      outputs: [{ presetIndex: 0, destination: 'd' }],
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(z.ZodError);
  expect((thrown as z.ZodError).issues).toEqual([
    expect.objectContaining({
      code: 'custom',
      path: ['variations', 0, 'variables', 1, 'assetIndex'],
      message: 'assetIndex is 1, but the spec has 1 asset',
    }),
  ]);
});

test('an assetIndex with no assets at all is out of range too, and an in-range one builds', () => {
  const base = {
    source: 's',
    presets: [{ presetId: 'p' }],
    outputs: [{ presetIndex: 0, destination: 'd' }],
  };
  expect(() =>
    buildRenderBody({ ...base, variations: [{ variables: [{ variableId: 'v', assetIndex: 0 }] }] }),
  ).toThrow('assetIndex is 0, but the spec has 0 assets');

  const body = buildRenderBody({
    ...base,
    assets: ['https://x/a0.png'],
    variations: [{ variables: [{ variableId: 'v', assetIndex: 0 }] }],
  });
  expect(body.variations?.[0]?.variables[0]?.assetIndex).toBe(0);
});

test('a spec with no variations gets one variation with no overrides on the wire', () => {
  const body = buildRenderBody({
    source: 's',
    presets: [{ presetId: 'p' }],
    outputs: [{ presetIndex: 0, destination: 'd' }],
  });
  expect(body.variations).toEqual([{ variables: [] }]);
  expect(body.outputs.every((output) => output.variationIndex < body.variations.length)).toBe(true);
});

test('a spec with an explicitly empty variations array also gets one variation with no overrides', () => {
  const body = buildRenderBody({
    source: 's',
    presets: [{ presetId: 'p' }],
    variations: [],
    outputs: [{ presetIndex: 0, destination: 'd' }],
  });
  expect(body.variations).toEqual([{ variables: [] }]);
});

test("every output's variationIndex stays within the wire body's variations length when the spec has none", () => {
  const body = buildRenderBody({
    source: 's',
    presets: [{ presetId: 'p' }],
    outputs: [
      { presetIndex: 0, destination: 'd0' },
      { presetIndex: 0, destination: 'd1' },
    ],
  });
  expect(body.variations).toHaveLength(1);
  expect(body.outputs.every((output) => output.variationIndex < body.variations.length)).toBe(true);
});

test('explicit variations pass through unchanged on the wire', () => {
  const variations = [
    { variables: [{ variableId: '0_0_media', assetIndex: 0 }] },
    { variables: [{ variableId: '0_0_media', value: 'Second' }] },
  ];
  const body = buildRenderBody({
    source: 's',
    presets: [{ presetId: 'p' }],
    assets: ['https://x/a0.png'],
    variations,
    outputs: [
      { variationIndex: 0, presetIndex: 0, destination: 'd0' },
      { variationIndex: 1, presetIndex: 0, destination: 'd1' },
    ],
  });
  expect(body.variations).toEqual(variations);
});

test('the wire variations schema rejects a body missing variations, or carrying an empty array', () => {
  expect(WireVariationsSchema.safeParse(undefined).success).toBe(false);
  expect(WireVariationsSchema.safeParse([]).success).toBe(false);
  expect(WireVariationsSchema.safeParse([{ variables: [] }]).success).toBe(true);
});
