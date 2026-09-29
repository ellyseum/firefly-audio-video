import { expect, test } from 'vitest';
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

test('named preset ref passes presetId through', () => {
  const body = buildRenderBody({
    source: 's',
    presets: [{ presetId: 'ffs_video_api_prores' }],
    outputs: [{ presetIndex: 0, destination: 'd' }],
  });
  expect(body.presets[0]).toEqual({ presetId: 'ffs_video_api_prores' });
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
