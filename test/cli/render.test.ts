import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AudioVideoError } from '../../src/core/errors.js';
import type { JobMeta } from '../../src/core/job.js';
import type { RenderRequest } from '../../src/dgr/schemas.js';
import { createFakeClient } from './support/fake-client.js';
import { createHarness } from './support/harness.js';
import { cancelledError, deferredJob, settledJob } from './support/job.js';

const SECRET = 'RENDER_TEST_SECRET_MUST_NEVER_APPEAR';

const META: JobMeta = { jobId: 'job-1', queueMs: 100, renderMs: 900, totalMs: 1000, perItem: [] };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'firefly-audio-video-cli-render-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.removeAllListeners('SIGINT');
});

function specFile(spec: unknown): string {
  const path = join(dir, 'spec.json');
  writeFileSync(path, JSON.stringify(spec));
  return path;
}

test('with no --out and no --resolve-as, human mode prints the bare output URL and exits 0', async () => {
  const render = vi.fn((_spec: RenderRequest, options: { resolveAs?: string }) => {
    expect(options.resolveAs).toBe('url');
    return settledJob(
      { value: 'https://out.example.test/render.mp4?sig=abc' },
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
      { value: 'https://out.example.test/render.mp4?sig=abc' },
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
    return settledJob({ value: 'https://out.example.test/a?sig=1' }, { meta: META });
  });
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run(['render', '--template', 't.mogrt', '--preset', 'prores']);
  expect(render).toHaveBeenCalledTimes(1);
});

test('builds the preset from --encode JSON instead of --preset', async () => {
  const render = vi.fn((spec: RenderRequest) => {
    expect(spec.presets).toEqual([{ codec: 'hevc', bitDepth: 10 }]);
    return settledJob({ value: 'https://out.example.test/a?sig=1' }, { meta: META });
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

test('--resolve-as file with --out saves to that path and prints the bare path', async () => {
  const outPath = join(dir, 'out.mp4');
  const render = vi.fn(
    (_spec: RenderRequest, options: { resolveAs?: string; savePath?: string }) => {
      expect(options).toEqual({ resolveAs: 'file', savePath: outPath });
      return settledJob({ value: outPath }, { jobId: 'job-1', meta: META });
    },
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
    '--resolve-as',
    'file',
  ]);
  expect(harness.stdoutText()).toBe(`${outPath}\n`);
});

test('--out alone (no --resolve-as) defaults to file mode', async () => {
  const outPath = join(dir, 'out.mp4');
  const render = vi.fn(
    (_spec: RenderRequest, options: { resolveAs?: string; savePath?: string }) => {
      expect(options).toEqual({ resolveAs: 'file', savePath: outPath });
      return settledJob({ value: outPath }, { meta: META });
    },
  );
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run(['render', '--template', 't.mogrt', '--preset', 'prores', '--out', outPath]);
  expect(harness.stdoutText()).toBe(`${outPath}\n`);
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
    return settledJob({ value: 'https://read.example.test' }, { meta: META });
  });
  const harness = createHarness({ client: createFakeClient({ render }) });
  await harness.run(['render', '--spec', specFile(spec)]);
  expect(render).toHaveBeenCalledTimes(1);
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

test('Ctrl+C cancels the job exactly once, prints one notice to stderr, and exits 130', async () => {
  const dj = deferredJob<string>({ jobId: 'job-1', meta: META });
  const render = vi.fn(() => dj.job);
  const harness = createHarness({ client: createFakeClient({ render }) });

  const run = harness.run(['render', '--template', 't.mogrt', '--preset', 'prores']);
  await Promise.resolve();
  await Promise.resolve();
  process.emit('SIGINT');
  await Promise.resolve();
  expect(dj.cancelCalls).toBe(1);
  dj.fail(cancelledError());
  await run;

  expect(harness.stderrText()).toBe(
    'Cancelling the render...\nError: The job was cancelled.\nCode: cancelled\n',
  );
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(130);
});

test('a second Ctrl+C exits 130 immediately, without waiting for the job to settle, and cancels only once', async () => {
  const dj = deferredJob<string>({ jobId: 'job-1', meta: META });
  const render = vi.fn(() => dj.job);
  const harness = createHarness({ client: createFakeClient({ render }) });

  const run = harness.run(['render', '--template', 't.mogrt', '--preset', 'prores']);
  await Promise.resolve();
  await Promise.resolve();
  process.emit('SIGINT');
  process.emit('SIGINT');

  // The job is still pending — .cancel() never settles it in this test double
  // — yet the second Ctrl+C already forced the exit.
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(130);
  expect(dj.cancelCalls).toBe(1);

  dj.fail(cancelledError());
  await run;
  // Settling afterward must not call exit a second time.
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(130);
});

test('Ctrl+C with no in-flight job (a synchronous validation failure) leaves no listener registered', async () => {
  const harness = createHarness({ client: createFakeClient({ render: vi.fn() }) });
  await harness.run(['render']); // fails validation before any render() call
  expect(process.listenerCount('SIGINT')).toBe(0);
});
