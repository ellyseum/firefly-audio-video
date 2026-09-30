import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createProgram } from '../../src/cli/program.js';
import { Asset } from '../../src/core/asset.js';
import { AudioVideoError } from '../../src/core/errors.js';
import type { JobMeta } from '../../src/core/job.js';
import type { RenderRequest } from '../../src/dgr/schemas.js';
import { flush, until } from '../support/mock-api.js';
import { createFakeClient } from './support/fake-client.js';
import { createHarness } from './support/harness.js';
import { cancelledError, deferredJob, settledJob } from './support/job.js';

const SECRET = 'RENDER_TEST_SECRET_MUST_NEVER_APPEAR';

const META: JobMeta = { jobId: 'job-1', queueMs: 100, renderMs: 900, totalMs: 1000, perItem: [] };

/** A finished output, as a spec render without `resolveAs` resolves with it. */
function asset(url: string): Asset {
  return new Asset({ url, meta: META });
}

/** A finished output whose download answers with `body`. */
function downloadableAsset(body: string): Asset {
  return new Asset({
    url: 'https://out.example.test/render.mp4?sig=abc',
    meta: META,
    fetch: async () => new Response(body, { headers: { 'content-length': String(body.length) } }),
  });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'firefly-audio-video-cli-render-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function specFile(spec: unknown): string {
  const path = join(dir, 'spec.json');
  writeFileSync(path, JSON.stringify(spec));
  return path;
}

test('with no --out and no --resolve-as, human mode prints the bare output URL and exits 0', async () => {
  const render = vi.fn((_spec: RenderRequest, options?: { resolveAs?: string }) => {
    expect(options).toBeUndefined();
    return settledJob(
      { value: asset('https://out.example.test/render.mp4?sig=abc') },
      { jobId: 'job-1', meta: META },
    );
  });
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run(['render', '--template', 't.mogrt', '--preset', 'prores']);
  expect(harness.stdoutText()).toBe('https://out.example.test/render.mp4?sig=abc\n');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test('--json mode reports jobId, output, queueMs, renderMs and totalMs as exactly one document', async () => {
  const render = vi.fn(() =>
    settledJob(
      { value: asset('https://out.example.test/render.mp4?sig=abc') },
      { jobId: 'job-1', meta: META },
    ),
  );
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run(['render', '--template', 't.mogrt', '--preset', 'prores', '--json']);
  const lines = harness
    .stdoutText()
    .split('\n')
    .filter((line) => line !== '');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? '')).toEqual({
    ok: true,
    jobId: 'job-1',
    output: 'https://out.example.test/render.mp4?sig=abc',
    queueMs: 100,
    renderMs: 900,
    totalMs: 1000,
  });
});

test('builds a one-output spec with no destination from --template and --preset', async () => {
  const render = vi.fn((spec: RenderRequest) => {
    expect(spec).toEqual({
      source: 't.mogrt',
      presets: ['prores'],
      outputs: [{ presetIndex: 0 }],
    });
    return settledJob({ value: asset('https://out.example.test/a?sig=1') }, { meta: META });
  });
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run(['render', '--template', 't.mogrt', '--preset', 'prores']);
  expect(render).toHaveBeenCalledTimes(1);
});

test('builds the preset from --encode JSON instead of --preset', async () => {
  const render = vi.fn((spec: RenderRequest) => {
    expect(spec.presets).toEqual([{ codec: 'hevc', bitDepth: 10 }]);
    return settledJob({ value: asset('https://out.example.test/a?sig=1') }, { meta: META });
  });
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run([
    'render',
    '--template',
    't.mogrt',
    '--encode',
    '{"codec":"hevc","bitDepth":10}',
  ]);
  expect(render).toHaveBeenCalledTimes(1);
});

test('--resolve-as file with --out saves the output to that path and prints the bare path', async () => {
  const outPath = join(dir, 'out.mp4');
  const render = vi.fn((_spec: RenderRequest, options?: { resolveAs?: string }) => {
    expect(options).toBeUndefined();
    return settledJob(
      { value: downloadableAsset('rendered-bytes') },
      { jobId: 'job-1', meta: META },
    );
  });
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run([
    'render',
    '--template',
    't.mogrt',
    '--preset',
    'prores',
    '--out',
    outPath,
    '--resolve-as',
    'file',
  ]);
  expect(harness.stdoutText()).toBe(`${outPath}\n`);
  expect(readFileSync(outPath, 'utf8')).toBe('rendered-bytes');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test('--out alone (no --resolve-as) defaults to file mode', async () => {
  const outPath = join(dir, 'out.mp4');
  const render = vi.fn(() => settledJob({ value: downloadableAsset('bytes') }, { meta: META }));
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run(['render', '--template', 't.mogrt', '--preset', 'prores', '--out', outPath]);
  expect(harness.stdoutText()).toBe(`${outPath}\n`);
  expect(readFileSync(outPath, 'utf8')).toBe('bytes');
});

test('--out --json reports the saved path under output, with the job and its timing', async () => {
  const outPath = join(dir, 'out.mp4');
  const render = vi.fn(() =>
    settledJob({ value: downloadableAsset('bytes') }, { jobId: 'job-1', meta: META }),
  );
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run([
    'render',
    '--template',
    't.mogrt',
    '--preset',
    'prores',
    '--out',
    outPath,
    '--json',
  ]);
  expect(JSON.parse(harness.stdoutText().trim())).toEqual({
    ok: true,
    jobId: 'job-1',
    output: outPath,
    queueMs: 100,
    renderMs: 900,
    totalMs: 1000,
  });
});

test('a save that fails after the render finished exits 1 with save_failed, the job and its redacted read URL', async () => {
  // A directory where the output file would go: moving the finished file into place fails.
  const outPath = join(dir, 'out.mp4');
  mkdirSync(outPath);
  const render = vi.fn(() =>
    settledJob({ value: downloadableAsset('bytes') }, { jobId: 'job-1', meta: META }),
  );
  const args = ['render', '--template', 't.mogrt', '--preset', 'prores', '--out', outPath];

  const human = createHarness({ client: createFakeClient({ render }) });
  await human.run(args);
  expect(human.stderrText()).toMatch(/failed while moving its temporary file into place\.\n/);
  expect(human.stderrText()).toContain(
    'Code: save_failed\nJob: job-1\nRead URL: https://out.example.test/render.mp4\n',
  );
  expect(human.stderrText()).not.toContain('sig=abc');
  expect(human.exit).toHaveBeenCalledExactlyOnceWith(1);

  const json = createHarness({ client: createFakeClient({ render }) });
  await json.run([...args, '--json']);
  expect(JSON.parse(json.stdoutText().trim())).toEqual({
    ok: false,
    error: {
      code: 'save_failed',
      message: expect.stringMatching(/failed while moving its temporary file into place\.$/),
      jobId: 'job-1',
      readUrl: 'https://out.example.test/render.mp4',
    },
  });
  expect(json.stdoutText()).not.toContain('sig=abc');
  expect(json.exit).toHaveBeenCalledExactlyOnceWith(1);
});

test('a render that fails before it finishes carries no read URL', async () => {
  const outPath = join(dir, 'out.mp4');
  const failure = new AudioVideoError({
    message: 'render failed',
    code: 'job_failed',
    jobId: 'job-1',
  });
  const render = vi.fn(() => settledJob<Asset>({ error: failure }));
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run([
    'render',
    '--template',
    't.mogrt',
    '--preset',
    'prores',
    '--out',
    outPath,
    '--json',
  ]);
  expect(JSON.parse(harness.stdoutText().trim())).toEqual({
    ok: false,
    error: { code: 'job_failed', message: 'render failed', jobId: 'job-1' },
  });
});

test('Ctrl+C while the finished output is saving stops the save and exits 130', async () => {
  const outPath = join(dir, 'out.mp4');
  let downloading = false;
  const hanging = new Asset({
    url: 'https://out.example.test/render.mp4?sig=abc',
    meta: META,
    fetch: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        downloading = true;
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
  });
  const render = vi.fn(() => settledJob({ value: hanging }, { jobId: 'job-1', meta: META }));
  const harness = createHarness({ client: createFakeClient({ render }) });

  const run = harness.run([
    'render',
    '--template',
    't.mogrt',
    '--preset',
    'prores',
    '--out',
    outPath,
  ]);
  await until(() => downloading);
  harness.interrupt();
  await run;

  expect(harness.stderrText()).toContain('Code: cancelled\n');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(130);
  expect(existsSync(outPath)).toBe(false);
});

test('--resolve-as file with no --out rejects invalid_argument, exit 2, before any render call', async () => {
  const render = vi.fn();
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run([
    'render',
    '--template',
    't.mogrt',
    '--preset',
    'prores',
    '--resolve-as',
    'file',
  ]);
  expect(render).not.toHaveBeenCalled();
  expect(harness.stderrText()).toContain('--resolve-as file requires --out');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});

test('an unrecognized --resolve-as value rejects invalid_argument, exit 2', async () => {
  const harness = createHarness({ client: createFakeClient({ render: vi.fn() }) });
  await harness.run([
    'render',
    '--template',
    't.mogrt',
    '--preset',
    'prores',
    '--resolve-as',
    'bogus',
  ]);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});

test('--spec reads a full render request from a JSON file and passes it through unchanged', async () => {
  const spec = {
    source: 'https://example.test/capsule.mogrt',
    presets: [{ presetId: 'ffs_video_api_land_1080p_hq' }],
    outputs: [
      {
        presetIndex: 0,
        destination: 'https://write.example.test',
        readUrl: 'https://read.example.test',
      },
    ],
  };
  const render = vi.fn((got: RenderRequest) => {
    expect(got).toEqual(spec);
    return settledJob({ value: asset('https://read.example.test') }, { meta: META });
  });
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run(['render', '--spec', specFile(spec)]);
  expect(render).toHaveBeenCalledTimes(1);
});

const URL_A = 'https://out.example.test/a.mp4?sig=A';
const URL_B = 'https://out.example.test/b.mp4?sig=B';

/** A spec with two outputs, each naming its own destination and read URL. */
const TWO_OUTPUTS = {
  source: 'https://example.test/capsule.mogrt',
  presets: ['h264Land1080pHq', 'h264Vert1920pHq'],
  outputs: [
    { presetIndex: 0, destination: 'https://write.example.test/a.mp4', readUrl: URL_A },
    { presetIndex: 1, destination: 'https://write.example.test/b.mp4', readUrl: URL_B },
  ],
};

/**
 * A render() double that keeps the SDK's own contract — `resolveAs` applies
 * only to a spec with exactly one output — and otherwise resolves with an
 * asset per output, in spec order.
 */
function twoOutputRender() {
  return vi.fn((spec: RenderRequest, options?: { resolveAs?: string }) => {
    if (options?.resolveAs !== undefined && spec.outputs.length !== 1) {
      return settledJob<Asset[]>({
        error: new AudioVideoError({
          message:
            'resolveAs applies to a render with exactly one output, and this spec has ' +
            `${spec.outputs.length}: resolve each asset yourself.`,
          code: 'invalid_argument',
        }),
      });
    }
    return settledJob({ value: [asset(URL_A), asset(URL_B)] }, { jobId: 'job-2', meta: META });
  });
}

test('a spec with several outputs prints each read URL on its own line, in spec order', async () => {
  const render = twoOutputRender();
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run(['render', '--spec', specFile(TWO_OUTPUTS)]);
  expect(harness.stdoutText()).toBe(`${URL_A}\n${URL_B}\n`);
  expect(render).toHaveBeenCalledExactlyOnceWith(TWO_OUTPUTS);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test('--json reports a several-output render with output as an array of read URLs', async () => {
  const harness = createHarness({ client: createFakeClient({ render: twoOutputRender() }) });
  await harness.run(['render', '--spec', specFile(TWO_OUTPUTS), '--json']);
  expect(JSON.parse(harness.stdoutText().trim())).toEqual({
    ok: true,
    jobId: 'job-2',
    output: [URL_A, URL_B],
    queueMs: 100,
    renderMs: 900,
    totalMs: 1000,
  });
});

test("--out with a several-output spec is refused in the CLI's terms, exit 2, before any render call", async () => {
  const render = vi.fn();
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run(['render', '--spec', specFile(TWO_OUTPUTS), '--out', join(dir, 'out.mp4')]);
  expect(render).not.toHaveBeenCalled();
  expect(harness.stderrText()).toBe(
    'Error: --out saves a render with one output, and this spec has 2: ' +
      "leave out --out to print each output's read URL.\nCode: invalid_argument\n",
  );
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});

test('--spec combined with --template is invalid_argument, exit 2, before any render call', async () => {
  const render = vi.fn();
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run(['render', '--spec', specFile({ source: 'x' }), '--template', 't.mogrt']);
  expect(render).not.toHaveBeenCalled();
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});

test('--spec on a file with invalid JSON is invalid_argument, exit 2', async () => {
  const path = join(dir, 'bad.json');
  writeFileSync(path, 'not json');
  const harness = createHarness({ client: createFakeClient({ render: vi.fn() }) });
  await harness.run(['render', '--spec', path]);
  expect(harness.stderrText()).toContain('Code: invalid_argument');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});

test('a spec the SDK schema rejects reports invalid_argument, exit 2', async () => {
  const failure = new AudioVideoError({
    message: 'Invalid render spec: outputs is required',
    code: 'invalid_argument',
  });
  const render = vi.fn(() => settledJob<string>({ error: failure }));
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run(['render', '--spec', specFile({ source: 'x', presets: [] })]);
  expect(harness.stderrText()).toContain('Code: invalid_argument');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});

test('with neither --spec nor --template, rejects invalid_argument, exit 2', async () => {
  const harness = createHarness({ client: createFakeClient({ render: vi.fn() }) });
  await harness.run(['render']);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});

test('with both --preset and --encode, rejects invalid_argument, exit 2', async () => {
  const harness = createHarness({ client: createFakeClient({ render: vi.fn() }) });
  await harness.run([
    'render',
    '--template',
    't.mogrt',
    '--preset',
    'prores',
    '--encode',
    '{"codec":"hevc"}',
  ]);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});

test.each<[code: string, expected: number]>([
  ['auth_failed', 3],
  ['job_failed', 4],
  ['invalid_response', 4],
  ['request_timeout', 5],
  ['storage_failed', 5],
])('a render failure coded %s maps to exit %i, human and --json alike', async (code, expected) => {
  const failure = new AudioVideoError({ message: 'render failed', code });
  const render = vi.fn(() => settledJob<string>({ error: failure }));

  const human = createHarness({ client: createFakeClient({ render }) });
  await human.run(['render', '--template', 't.mogrt', '--preset', 'prores']);
  expect(human.stderrText()).toBe(`Error: render failed\nCode: ${code}\n`);
  expect(human.exit).toHaveBeenCalledExactlyOnceWith(expected);

  const json = createHarness({ client: createFakeClient({ render }) });
  await json.run(['render', '--template', 't.mogrt', '--preset', 'prores', '--json']);
  expect(JSON.parse(json.stdoutText().trim())).toEqual({
    ok: false,
    error: { code, message: 'render failed' },
  });
  expect(json.exit).toHaveBeenCalledExactlyOnceWith(expected);
});

test('the --json failure document carries the job and request IDs the error has', async () => {
  const failure = new AudioVideoError({
    message: 'render failed',
    code: 'job_failed',
    jobId: 'job-9',
    requestId: 'req-9',
  });
  const render = vi.fn(() => settledJob<string>({ error: failure }));
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run(['render', '--template', 't.mogrt', '--preset', 'prores', '--json']);
  expect(JSON.parse(harness.stdoutText().trim())).toEqual({
    ok: false,
    error: { code: 'job_failed', message: 'render failed', jobId: 'job-9', requestId: 'req-9' },
  });
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(4);
});

/** A failed job's items, as the SDK builds them from the status body's `outputs[].errors`. */
const MISSING_FONT_ITEMS = [
  {
    index: 0,
    errors: [
      {
        code: 'missing_font',
        message: 'The template uses font AdobeClean-Bold, which must be uploaded with the render.',
      },
    ],
  },
];

function missingFontFailure(): AudioVideoError {
  return new AudioVideoError({
    message: 'Job job-1 failed: errors on output 0.',
    code: 'job_failed',
    jobId: 'job-1',
    items: MISSING_FONT_ITEMS,
  });
}

test("a failed job's first reason follows the message on the error line", async () => {
  const render = vi.fn(() => settledJob<string>({ error: missingFontFailure() }));
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run(['render', '--template', 't.mogrt', '--preset', 'prores']);
  expect(harness.stderrText()).toBe(
    'Error: Job job-1 failed: errors on output 0. Reason: missing_font: ' +
      'The template uses font AdobeClean-Bold, which must be uploaded with the render.\n' +
      'Code: job_failed\n',
  );
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(4);
});

test("the --json failure document carries every reason the error's items hold", async () => {
  const render = vi.fn(() => settledJob<string>({ error: missingFontFailure() }));
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run(['render', '--template', 't.mogrt', '--preset', 'prores', '--json']);
  expect(JSON.parse(harness.stdoutText().trim())).toEqual({
    ok: false,
    error: {
      code: 'job_failed',
      message: 'Job job-1 failed: errors on output 0.',
      jobId: 'job-1',
      items: MISSING_FONT_ITEMS,
    },
  });
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(4);
});

test("a signed URL in a failure's reason reaches neither stream", async () => {
  const signature = 'REASON_WRITE_SIG_MUST_NOT_PRINT';
  const writeUrl = `https://acct.blob.core.windows.net/c/out.mov?sv=2021&sp=cw&sig=${signature}`;
  const failure = new AudioVideoError({
    message: 'Job job-1 failed: errors on output 0.',
    code: 'job_failed',
    items: [{ index: 0, errors: [{ message: `could not write ${writeUrl}` }] }],
  });
  const render = vi.fn(() => settledJob<string>({ error: failure }));

  const human = createHarness({ client: createFakeClient({ render }) });
  await human.run(['render', '--template', 't.mogrt', '--preset', 'prores']);
  expect(human.stderrText()).toContain(
    'Reason: could not write https://acct.blob.core.windows.net/c/out.mov\n',
  );
  expect(human.stderrText()).not.toContain(signature);

  const json = createHarness({ client: createFakeClient({ render }) });
  await json.run(['render', '--template', 't.mogrt', '--preset', 'prores', '--json']);
  expect(json.stdoutText()).toContain(
    'could not write https://acct.blob.core.windows.net/c/out.mov',
  );
  expect(json.stdoutText()).not.toContain(signature);
});

test('a cancelled error this process did not initiate maps to exit 4, not 130', async () => {
  const failure = new AudioVideoError({
    message: 'cancelled by another caller',
    code: 'cancelled',
  });
  const render = vi.fn(() => settledJob<string>({ error: failure }));
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run(['render', '--template', 't.mogrt', '--preset', 'prores']);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(4);
});

test('missing credentials for a real client are reported before any render call', async () => {
  const render = vi.fn();
  const harness = createHarness({ env: {} }); // no injected client, no credentials
  await harness.run(['render', '--template', 't.mogrt', '--preset', 'prores']);
  expect(render).not.toHaveBeenCalled();
  expect(harness.stderrText()).toContain('No credentials configured');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});

test('no secret given via --client-secret or the environment ever reaches stdout or stderr', async () => {
  const failure = new AudioVideoError({ message: 'boom', code: 'request_failed' });
  const render = vi.fn(() => settledJob<string>({ error: failure }));

  const viaFlag = createHarness({ client: createFakeClient({ render }) });
  await viaFlag.run([
    'render',
    '--template',
    't.mogrt',
    '--preset',
    'prores',
    '--client-secret',
    SECRET,
    '--json',
  ]);
  expect(viaFlag.stdoutText()).not.toContain(SECRET);
  expect(viaFlag.stderrText()).not.toContain(SECRET);

  const viaEnv = createHarness({
    client: createFakeClient({ render }),
    env: { IMS_OAUTH_S2S_CLIENT_SECRET: SECRET },
  });
  await viaEnv.run(['render', '--template', 't.mogrt', '--preset', 'prores']);
  expect(viaEnv.stdoutText()).not.toContain(SECRET);
  expect(viaEnv.stderrText()).not.toContain(SECRET);
});

test('Ctrl+C cancels the job once and exits 130 only after its cancel request has been sent', async () => {
  const dj = deferredJob<string>({ jobId: 'job-1', meta: META });
  const harness = createHarness({ client: createFakeClient({ render: vi.fn(() => dj.job) }) });

  const run = harness.run(['render', '--template', 't.mogrt', '--preset', 'prores']);
  await until(() => harness.interruptListeners() === 1);
  harness.interrupt();
  expect(dj.cancelCalls).toBe(1);
  dj.fail(cancelledError());
  await until(() => harness.stderrText().includes('Code: cancelled'));
  await flush();

  // The job has rejected and its failure is printed; the cancel request is still in flight.
  expect(harness.exit).not.toHaveBeenCalled();
  dj.finishCancel();
  await run;

  expect(harness.stderrText()).toBe(
    'Cancelling the render...\nError: The job was cancelled.\nCode: cancelled\n',
  );
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(130);
  expect(harness.forceExit).not.toHaveBeenCalled();
});

test('a cancel request that never settles holds the exit for ten seconds, then exits 130', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const dj = deferredJob<string>({ jobId: 'job-1', meta: META });
    const harness = createHarness({ client: createFakeClient({ render: vi.fn(() => dj.job) }) });

    const run = harness.run(['render', '--template', 't.mogrt', '--preset', 'prores']);
    await until(() => harness.interruptListeners() === 1);
    harness.interrupt();
    dj.fail(cancelledError());
    await until(() => harness.stderrText().includes('Code: cancelled'));

    await vi.advanceTimersByTimeAsync(9_999);
    expect(harness.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await run;

    expect(harness.exit).toHaveBeenCalledExactlyOnceWith(130);
    expect(harness.forceExit).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test('once the cancel request settles, no timer is left to hold the process open', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const dj = deferredJob<string>({ jobId: 'job-1', meta: META });
    const harness = createHarness({ client: createFakeClient({ render: vi.fn(() => dj.job) }) });

    const run = harness.run(['render', '--template', 't.mogrt', '--preset', 'prores']);
    await until(() => harness.interruptListeners() === 1);
    harness.interrupt();
    dj.fail(cancelledError());
    await until(() => harness.stderrText().includes('Code: cancelled'));
    dj.finishCancel();
    await run;

    expect(harness.exit).toHaveBeenCalledExactlyOnceWith(130);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('a second Ctrl+C ends the process at once with 130, without waiting for the job, and cancels only once', async () => {
  const dj = deferredJob<string>({ jobId: 'job-1', meta: META });
  const harness = createHarness({ client: createFakeClient({ render: vi.fn(() => dj.job) }) });

  const run = harness.run(['render', '--template', 't.mogrt', '--preset', 'prores']);
  await until(() => harness.interruptListeners() === 1);
  harness.interrupt();
  harness.interrupt();

  // The job is still pending — .cancel() never settles it in this test double
  // — yet the second Ctrl+C already ended the process.
  expect(harness.forceExit).toHaveBeenCalledExactlyOnceWith(130);
  expect(dj.cancelCalls).toBe(1);

  dj.fail(cancelledError());
  dj.finishCancel();
  await run;
  // Settling afterward sets no exit code and ends nothing a second time.
  expect(harness.forceExit).toHaveBeenCalledExactlyOnceWith(130);
  expect(harness.exit).not.toHaveBeenCalled();
});

test('a second Ctrl+C while the cancel request is still in flight ends the process at once', async () => {
  const dj = deferredJob<string>({ jobId: 'job-1', meta: META });
  const harness = createHarness({ client: createFakeClient({ render: vi.fn(() => dj.job) }) });

  const run = harness.run(['render', '--template', 't.mogrt', '--preset', 'prores']);
  await until(() => harness.interruptListeners() === 1);
  harness.interrupt();
  dj.fail(cancelledError());
  await until(() => harness.stderrText().includes('Code: cancelled'));
  expect(harness.forceExit).not.toHaveBeenCalled();

  harness.interrupt();
  expect(harness.forceExit).toHaveBeenCalledExactlyOnceWith(130);

  dj.finishCancel();
  await run;
  expect(harness.exit).not.toHaveBeenCalled();
});

test('Ctrl+C with no in-flight job (a synchronous validation failure) never subscribes a listener', async () => {
  const harness = createHarness({ client: createFakeClient({ render: vi.fn() }) });
  await harness.run(['render']); // fails validation before any render() call
  expect(harness.interruptListeners()).toBe(0);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});

test('the Ctrl+C listener is subscribed while the job runs and released once it succeeds', async () => {
  const dj = deferredJob<Asset>({ jobId: 'job-1', meta: META });
  const harness = createHarness({ client: createFakeClient({ render: vi.fn(() => dj.job) }) });

  const run = harness.run(['render', '--template', 't.mogrt', '--preset', 'prores']);
  await until(() => harness.interruptListeners() === 1);
  dj.settle(asset('https://out.example.test/render.mp4'));
  await run;

  expect(harness.interruptListeners()).toBe(0);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test('the Ctrl+C listener is released once the job fails', async () => {
  const dj = deferredJob<string>({ jobId: 'job-1', meta: META });
  const harness = createHarness({ client: createFakeClient({ render: vi.fn(() => dj.job) }) });

  const run = harness.run(['render', '--template', 't.mogrt', '--preset', 'prores']);
  await until(() => harness.interruptListeners() === 1);
  dj.fail(new AudioVideoError({ message: 'render failed', code: 'job_failed' }));
  await run;

  expect(harness.interruptListeners()).toBe(0);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(4);
});

test("by default render listens on the process's SIGINT while the job runs, and stops once it ends", async () => {
  const baseline = process.listenerCount('SIGINT');
  const dj = deferredJob<string>({ jobId: 'job-1', meta: META });
  const exit = vi.fn<(code: number) => void>();
  const forceExit = vi.fn<(code: number) => void>();
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  const program = createProgram({
    client: createFakeClient({ render: vi.fn(() => dj.job) }),
    env: {},
    stdout: sink,
    stderr: sink,
    exit,
    forceExit,
  });

  const run = program.parseAsync(['render', '--template', 't.mogrt', '--preset', 'prores'], {
    from: 'user',
  });
  try {
    await until(() => process.listenerCount('SIGINT') === baseline + 1);
    process.emit('SIGINT');
    expect(dj.cancelCalls).toBe(1);
  } finally {
    dj.fail(cancelledError());
    dj.finishCancel();
    await run;
  }

  expect(process.listenerCount('SIGINT')).toBe(baseline);
  expect(exit).toHaveBeenCalledExactlyOnceWith(130);
  expect(forceExit).not.toHaveBeenCalled();
});
