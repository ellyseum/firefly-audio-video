import { expect, test } from 'vitest';
import * as z from 'zod';
import { buildRenderBody } from '../src/dgr/build-body.js';
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

test('an invalid spec throws a zod error', () => {
  expect(() => buildRenderBody({ source: 's', presets: [] } as unknown as RenderSpec)).toThrow();
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
