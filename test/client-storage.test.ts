import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { Asset } from '../src/core/asset.js';
import { AudioVideoError } from '../src/core/errors.js';
import { createClient, type Client, type ClientConfig } from '../src/dgr/client.js';
import type { RenderRequest } from '../src/dgr/schemas.js';
import {
  MockApi,
  STORAGE,
  fakeStorage,
  recordingLogger,
  succeeded,
  wireOutput,
  type FakeStorage,
} from './support/mock-api.js';

const CAPSULE = `${STORAGE}/capsule.mogrt?sv=2021&sp=r&sig=CAPSULE_SIG`;
const WRITE = `${STORAGE}/out/a.mov?sv=2021&sp=w&sig=WRITE_SIG_A`;
const READ = `${STORAGE}/out/a.mov?sv=2021&sp=r&sig=READ_SIG_A`;

let api: MockApi;
let dir: string;
let logo: string;
let epr: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fav-client-storage-'));
  logo = join(dir, 'logo.png');
  epr = join(dir, 'My Preset.epr');
  writeFileSync(logo, 'png bytes');
  writeFileSync(epr, '<PremiereData Version="3"/>');
});

afterAll(() => {
  unlinkSync(logo);
  unlinkSync(epr);
  rmdirSync(dir);
});

beforeEach(() => {
  api = new MockApi();
  api.ims();
});

afterEach(async () => {
  await api.close();
});

function client(extra: Partial<ClientConfig> = {}): Client {
  return createClient({ clientId: 'client-id', clientSecret: 'SECRET', logging: false, ...extra });
}

/** The `AudioVideoError` a promise rejects with. */
async function rejection(promise: PromiseLike<unknown>): Promise<AudioVideoError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AudioVideoError);
    return error as AudioVideoError;
  }
  throw new Error('expected a rejection');
}

/** The staged read URL `fakeStorage()` returns for its `n`th call. */
function staged(n: number): string {
  return `${STORAGE}/staged/${n}.epr?sv=2021&sp=r&sig=STAGE_SIG_${n}`;
}

/** A job that succeeds on its first poll with one output written to `destination`. */
function succeedsWith(jobId: string, destination: string): void {
  api.submit([jobId]);
  api.status(jobId, () => succeeded(jobId, [wireOutput(0, 0, 10, 40, destination)]));
}

test('a Buffer template source and a file-path asset are staged, and their read URLs are what DGR is sent', async () => {
  const storage = fakeStorage();
  succeedsWith('job-a', WRITE);
  const capsule = Buffer.from('mogrt bytes');

  const asset = await client({ storage }).render(
    {
      source: capsule,
      presets: [{ presetId: 'ffs_video_api_land_1080p_hq' }],
      assets: [logo, `${STORAGE}/headshot.png`],
      variations: [{ variables: [{ variableId: '0_0_media', assetIndex: 0 }] }],
      outputs: [{ presetIndex: 0, destination: WRITE, readUrl: READ }],
    },
    { pollIntervalMs: 0 },
  );

  expect(asset.url).toBe(READ);
  const inputs = storage.staged.map((entry) => entry.input);
  expect(inputs).toHaveLength(2);
  expect(inputs).toContain(capsule);
  expect(inputs).toContain(logo);
  const url = (input: unknown): string => staged(inputs.indexOf(input) + 1);
  const [body] = api.submitted();
  expect(body?.source).toEqual({ url: url(capsule) });
  expect(body?.assets).toEqual([
    { source: { url: url(logo) } },
    { source: { url: `${STORAGE}/headshot.png` } },
  ]);
});

test('a Readable asset reaches stageRead as the same stream', async () => {
  const storage = fakeStorage();
  succeedsWith('job-r', WRITE);
  const stream = Readable.from([Buffer.from('png')]);
  await client({ storage }).render(
    {
      source: CAPSULE,
      presets: ['h264Land1080pHq'],
      assets: [stream],
      outputs: [{ presetIndex: 0, destination: WRITE }],
    },
    { pollIntervalMs: 0 },
  );
  expect(storage.staged).toHaveLength(1);
  expect(storage.staged[0]?.input).toBe(stream);
  expect(api.submitted()[0]?.assets).toEqual([{ source: { url: staged(1) } }]);
});

test('a { url } preset given as a Buffer or a file path is staged as XML and submitted by URL', async () => {
  const storage = fakeStorage();
  api.submit(['job-p']);
  api.status('job-p', () =>
    succeeded('job-p', [wireOutput(0, 0, 1, 2, WRITE), wireOutput(0, 1, 1, 2, `${WRITE}&b`)]),
  );
  const xml = Buffer.from('<PremiereData Version="3"/>');

  await client({ storage }).render(
    {
      source: CAPSULE,
      presets: [{ url: xml }, { url: epr }],
      outputs: [
        { presetIndex: 0, destination: WRITE },
        { presetIndex: 1, destination: `${WRITE}&b` },
      ],
    },
    { pollIntervalMs: 0 },
  );

  expect(storage.staged.map((entry) => entry.opts)).toEqual([
    { contentType: 'application/xml' },
    { contentType: 'application/xml' },
  ]);
  const inputs = storage.staged.map((entry) => entry.input);
  expect(inputs).toContain(xml);
  expect(inputs).toContain(epr);
  const [body] = api.submitted();
  expect(body?.presets).toEqual([
    { source: { url: staged(inputs.indexOf(xml) + 1) } },
    { source: { url: staged(inputs.indexOf(epr) + 1) } },
  ]);
});

test('a { url } preset given as an http(s) URL string or URL object is submitted as it is, with no storage', async () => {
  succeedsWith('job-u', WRITE);
  const eprUrl = `${STORAGE}/presets/p.epr?sig=EPR_SIG`;
  await client().render(
    {
      source: new URL(CAPSULE),
      presets: [{ url: new URL(eprUrl) }],
      outputs: [{ presetIndex: 0, destination: WRITE }],
    },
    { pollIntervalMs: 0 },
  );
  const [body] = api.submitted();
  expect(body?.source).toEqual({ url: new URL(CAPSULE).href });
  expect(body?.presets).toEqual([{ source: { url: new URL(eprUrl).href } }]);
});

test("an output without a destination renders into storage's allocation: its write URL is sent, and the Asset reads its read URL", async () => {
  const storage = fakeStorage();
  api.submit(['job-o']);
  api.status('job-o', () =>
    succeeded('job-o', [wireOutput(0, 0, 10, 40, storage.allocations[0]?.writeUrl)]),
  );

  const asset = await client({ storage }).render(
    { source: CAPSULE, presets: ['h264Land1080pHq'], outputs: [{ presetIndex: 0 }] },
    { pollIntervalMs: 0 },
  );

  expect(storage.allocations).toHaveLength(1);
  const slot = storage.allocations[0];
  expect(asset).toBeInstanceOf(Asset);
  expect(asset.url).toBe(slot?.readUrl);
  expect(api.submitted()[0]?.outputs).toEqual([
    { variationIndex: 0, presetIndex: 0, destination: { url: slot?.writeUrl } },
  ]);
});

test('an output without a destination and no storage rejects invalid_argument before any request', async () => {
  const error = await rejection(
    client().render({
      source: CAPSULE,
      presets: ['h264Land1080pHq'],
      outputs: [{ presetIndex: 0 }],
    }),
  );
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('outputs[0] has no destination');
  expect(error.message).toContain('storage option');
  expect(api.calls).toEqual([]);
});

test('a readUrl with no destination rejects invalid_argument: storage would allocate both URLs', async () => {
  const storage = fakeStorage();
  const error = await rejection(
    client({ storage }).render({
      source: CAPSULE,
      presets: ['h264Land1080pHq'],
      outputs: [{ presetIndex: 0, readUrl: READ }],
    }),
  );
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('outputs[0] has a readUrl but no destination');
  expect(storage.allocations).toEqual([]);
  expect(api.calls).toEqual([]);
});

test('an input that needs uploading with no storage rejects invalid_argument naming it and the option, before any request', async () => {
  const cases: Array<[Partial<RenderRequest>, string]> = [
    [{ source: Buffer.from('mogrt') }, 'source'],
    [{ assets: [`${STORAGE}/a.png`, logo] }, 'assets[1]'],
    [{ presets: [{ url: epr }] }, 'presets[0].url'],
  ];
  for (const [overrides, where] of cases) {
    const error = await rejection(
      client().render({
        source: CAPSULE,
        presets: ['h264Land1080pHq'],
        outputs: [{ presetIndex: 0, destination: WRITE }],
        ...overrides,
      }),
    );
    expect(error.code).toBe('invalid_argument');
    expect(error.message.startsWith(`${where} must be uploaded`)).toBe(true);
    expect(error.message).toContain('storage option');
  }
  expect(api.calls).toEqual([]);
});

test('an input that is neither a URL nor a file rejects invalid_argument naming its field, and nothing is uploaded first', async () => {
  const storage = fakeStorage();
  const error = await rejection(
    client({ storage }).render({
      source: Buffer.from('mogrt'),
      presets: ['h264Land1080pHq'],
      assets: [logo, './no-such-image.png'],
      outputs: [{ presetIndex: 0 }],
    }),
  );
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toBe(
    'assets[1]: The input "./no-such-image.png" is neither an http(s) URL nor an existing file.',
  );
  expect(storage.staged).toEqual([]);
  expect(storage.allocations).toEqual([]);
  expect(api.calls).toEqual([]);
});

test('a { url } preset that is neither a URL nor a file rejects invalid_argument naming presets[i].url', async () => {
  const error = await rejection(
    client({ storage: fakeStorage() }).render({
      source: CAPSULE,
      presets: [{ url: 'no-such.epr' }],
      outputs: [{ presetIndex: 0, destination: WRITE }],
    }),
  );
  expect(error.code).toBe('invalid_argument');
  expect(error.message.startsWith('presets[0].url: ')).toBe(true);
});

test('a spec field that is not a render input at all rejects invalid_argument from validation', async () => {
  const error = await rejection(
    client({ storage: fakeStorage() }).render({
      source: 42,
      presets: ['h264Land1080pHq'],
      assets: [''],
      outputs: [{ presetIndex: 0, destination: WRITE }],
    } as unknown as RenderRequest),
  );
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain(
    'source: source must be an http(s) URL, a file path, a URL, a Buffer or a Readable',
  );
  expect(error.message).toContain('assets.0: asset must not be empty');
});

test('an assetIndex past the end of assets rejects invalid_argument before anything is uploaded', async () => {
  const storage = fakeStorage();
  const error = await rejection(
    client({ storage }).render({
      source: Buffer.from('mogrt'),
      presets: ['h264Land1080pHq'],
      assets: [logo],
      variations: [{ variables: [{ variableId: '0_0_media', assetIndex: 3 }] }],
      outputs: [{ presetIndex: 0 }],
    }),
  );
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('assetIndex is 3, but the spec has 1 asset');
  expect(storage.staged).toEqual([]);
  expect(storage.allocations).toEqual([]);
});

test('a failed upload rejects storage_failed naming its field, and the job is never submitted', async () => {
  const leak = `${STORAGE}/c/logo.png?sv=2021&sp=cw&sig=UPLOAD_SIG_LEAK`;
  const cause = new Error(`PUT ${leak} answered 403`);
  const logger = recordingLogger();
  const storage: FakeStorage = {
    ...fakeStorage(),
    stageRead: () => Promise.reject(cause),
  };

  const error = await rejection(
    client({ storage, logging: logger }).render({
      source: CAPSULE,
      presets: ['h264Land1080pHq'],
      assets: [logo],
      outputs: [{ presetIndex: 0, destination: WRITE }],
    }),
  );

  expect(error.code).toBe('storage_failed');
  expect(error.message).toBe('assets[0]: Staging the input failed.');
  expect(api.submitted()).toEqual([]);
  const printed = [
    error.message,
    String(error),
    JSON.stringify(error),
    inspect(error),
    JSON.stringify(logger.records),
  ].join('\n');
  expect(printed).not.toContain('UPLOAD_SIG_LEAK');
  expect(logger.records).toHaveLength(1);
  expect(logger.records[0]?.error).toBe('storage_failed: assets[0]: Staging the input failed.');
});

test('staged and allocated URLs never reach the render log record', async () => {
  const storage = fakeStorage();
  const logger = recordingLogger();
  api.submit(['job-l']);
  api.status('job-l', () =>
    succeeded('job-l', [wireOutput(0, 0, 10, 40, storage.allocations[0]?.writeUrl)]),
  );
  await client({ storage, logging: logger }).render(
    {
      source: Buffer.from('mogrt'),
      presets: ['h264Land1080pHq'],
      outputs: [{ presetIndex: 0 }],
    },
    { pollIntervalMs: 0 },
  );
  const printed = JSON.stringify(logger.records);
  expect(logger.records).toHaveLength(1);
  expect(printed).not.toMatch(/STAGE_SIG|WRITE_SIG|READ_SIG/);
});
