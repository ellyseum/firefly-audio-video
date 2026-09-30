import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { Asset } from '../src/core/asset.js';
import { AudioVideoError } from '../src/core/errors.js';
import { InMemoryPool, type PoolBackend } from '../src/core/pool.js';
import { createClient, type Client, type ClientConfig } from '../src/dgr/client.js';
import type { RenderRequest, TemplateSource } from '../src/dgr/schemas.js';
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
let capsule: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fav-client-storage-'));
  logo = join(dir, 'logo.png');
  epr = join(dir, 'My Preset.epr');
  capsule = join(dir, 'capsule.mogrt');
  writeFileSync(logo, 'png bytes');
  writeFileSync(epr, '<PremiereData Version="3"/>');
  writeFileSync(capsule, 'mogrt bytes on disk');
});

afterAll(() => {
  unlinkSync(logo);
  unlinkSync(epr);
  unlinkSync(capsule);
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
    { contentType: 'application/xml', signal: expect.any(AbortSignal) },
    { contentType: 'application/xml', signal: expect.any(AbortSignal) },
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

// --- render(source) and describe(source) read a template as render({ source }) does ----------

/** A staged read URL `fakeStorage()` returns, whatever its call number. */
const STAGED_URL = /^https:\/\/storage\.example\/staged\/\d+\.epr\?sv=2021&sp=r&sig=STAGE_SIG_\d+$/;

interface TemplateForm {
  readonly name: string;
  /** A fresh template in this form. */
  readonly make: () => TemplateSource;
  /** What `stageRead` must be handed for `made`, or `undefined` for a URL sent as it is. */
  readonly staged: (made: TemplateSource) => unknown;
}

/** Every form a spec's `source` takes, alone or as `{ url }`. */
function templateForms(): TemplateForm[] {
  return [
    { name: 'an http(s) URL string', make: () => CAPSULE, staged: () => undefined },
    { name: 'an http(s) URL object', make: () => new URL(CAPSULE), staged: () => undefined },
    {
      name: '{ url } holding a URL string',
      make: () => ({ url: CAPSULE }),
      staged: () => undefined,
    },
    { name: 'a file path', make: () => capsule, staged: () => capsule },
    { name: 'a file: URL object', make: () => pathToFileURL(capsule), staged: () => capsule },
    { name: 'a file: URL string', make: () => pathToFileURL(capsule).href, staged: () => capsule },
    { name: 'a Buffer', make: () => Buffer.from('mogrt bytes'), staged: (made) => made },
    {
      name: 'a Readable',
      make: () => Readable.from([Buffer.from('mogrt bytes')]),
      staged: (made) => made,
    },
    {
      name: '{ url } holding a Buffer',
      make: () => ({ url: Buffer.from('mogrt bytes') }),
      staged: (made) => (made as { url: Buffer }).url,
    },
  ];
}

/** Checks the source DGR was sent for `made`, and what storage was handed for it. */
function expectSent(form: TemplateForm, made: TemplateSource, body: unknown, storage: FakeStorage) {
  const source = (body as { source?: unknown } | undefined)?.source;
  const input = form.staged(made);
  if (input === undefined) {
    expect(storage.staged).toEqual([]);
    expect(source).toEqual({ url: CAPSULE });
    return;
  }
  expect(storage.staged).toHaveLength(1);
  expect(storage.staged[0]?.input).toBe(input);
  expect(source).toEqual({ url: expect.stringMatching(STAGED_URL) });
}

test.each(templateForms())('render($name) sends DGR what a spec source would', async (form) => {
  const storage = fakeStorage();
  api.submit(['job-f']);
  api.status('job-f', () =>
    succeeded('job-f', [wireOutput(0, 0, 1, 2, storage.allocations[0]?.writeUrl)]),
  );
  const made = form.make();
  await client({ storage }).render(made, { pollIntervalMs: 0 }).prores;
  expectSent(form, made, api.submitted()[0], storage);
});

test.each(templateForms())('describe($name) sends DGR what a spec source would', async (form) => {
  const storage = fakeStorage();
  api.submit(['d-f'], { path: '/v1/templates/describe' });
  api.status('d-f', () => ({ jobId: 'd-f', status: 'succeeded' }));
  const made = form.make();
  await client({ storage }).describe(made, { pollIntervalMs: 0 });
  expectSent(form, made, api.submitted('/v1/templates/describe')[0], storage);
});

test('describe({ source, type, compName }) uploads a Buffer source and keeps type and compName', async () => {
  const storage = fakeStorage();
  api.submit(['d-aep'], { path: '/v1/templates/describe' });
  api.status('d-aep', () => ({ jobId: 'd-aep', status: 'succeeded' }));
  const zip = Buffer.from('zip bytes');
  await client({ storage }).describe(
    { source: zip, type: 'aep', compName: 'Main' },
    { pollIntervalMs: 0 },
  );
  expect(storage.staged.map((entry) => entry.input)).toEqual([zip]);
  expect(api.submitted('/v1/templates/describe')).toEqual([
    { source: { url: expect.stringMatching(STAGED_URL) }, type: 'aep', compName: 'Main' },
  ]);
});

/** An in-memory pool that counts every `run()` call. */
function countingPool(): PoolBackend & { readonly runs: number } {
  const inner = new InMemoryPool();
  let runs = 0;
  return {
    run: (task) => {
      runs += 1;
      return inner.run(task);
    },
    drain: () => inner.drain(),
    get active() {
      return inner.active;
    },
    get queued() {
      return inner.queued;
    },
    get runs() {
      return runs;
    },
  };
}

test.each<[string, () => unknown]>([
  ['a path that names no file', () => './no/such/capsule.mogrt'],
  ['a string that is not a URL', () => 'not a url'],
  ['a data: URL string', () => 'data:text/plain,mogrt'],
  ['an ftp: URL string', () => 'ftp://example.com/capsule.mogrt'],
  ['a data: URL object', () => new URL('data:text/plain,mogrt')],
  ['an ftp: URL object', () => new URL('ftp://example.com/capsule.mogrt')],
  ['an empty string', () => ''],
  ['{ url } holding a path that names no file', () => ({ url: './no/such/capsule.mogrt' })],
])(
  '%s is refused invalid_argument by render(source), describe(source) and a spec alike, before any pool slot or request',
  async (_name, make) => {
    const storage = fakeStorage();
    const pool = countingPool();
    const c = client({ storage, pool });
    const fluent = await rejection(c.render(make() as TemplateSource).prores);
    const described = await rejection(c.describe(make() as TemplateSource));
    const spec = await rejection(
      c.render({
        source: ((made) =>
          typeof made === 'object' && made !== null && 'url' in made ? made.url : made)(
          make(),
        ) as RenderRequest['source'],
        presets: ['h264Land1080pHq'],
        outputs: [{ presetIndex: 0, destination: WRITE }],
      }),
    );
    for (const error of [fluent, described, spec]) expect(error.code).toBe('invalid_argument');
    expect(described.message).toBe(fluent.message);
    expect(fluent.message.startsWith('source')).toBe(true);
    expect(pool.runs).toBe(0);
    expect(storage.staged).toEqual([]);
    expect(api.calls).toEqual([]);
  },
);

test('describe() of a value that is no template at all is refused invalid_argument, naming the forms it takes', async () => {
  const error = await rejection(
    client({ storage: fakeStorage() }).describe(42 as unknown as TemplateSource),
  );
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toBe(
    'source must be an http(s) URL, a file path, a URL, a Buffer or a Readable, or { url } holding one',
  );
  expect(api.calls).toEqual([]);
});

test('a mistyped path is refused with the same message by render(source), describe(source) and a spec', async () => {
  const c = client({ storage: fakeStorage() });
  const typo = './no/such/capsule.mogrt';
  const expected = `source: The input "${typo}" is neither an http(s) URL nor an existing file.`;
  expect((await rejection(c.render(typo).prores)).message).toBe(expected);
  expect((await rejection(c.describe(typo))).message).toBe(expected);
  const spec = await rejection(
    c.render({ source: typo, presets: ['prores'], outputs: [{ presetIndex: 0 }] }),
  );
  expect(spec.message).toBe(expected);
});

test('a template to upload with no storage configured is refused invalid_argument naming the storage option, before any request', async () => {
  const c = client();
  const fluent = await rejection(c.render(Buffer.from('mogrt')).prores);
  const described = await rejection(c.describe(Buffer.from('mogrt')));
  expect(fluent.code).toBe('invalid_argument');
  expect(fluent.message).toContain('storage option');
  expect(described.code).toBe('invalid_argument');
  expect(described.message.startsWith('source must be uploaded for DGR to read it')).toBe(true);
  expect(described.message).toContain('storage option');
  expect(api.calls).toEqual([]);
});
