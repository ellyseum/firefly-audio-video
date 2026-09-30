/**
 * The `dgr` entry point as a real process: a networked command ends with the
 * exit code it chose and exactly one JSON document on stdout under `--json`.
 * On Windows, a `process.exit()` while a fetch's handles are closing aborts
 * Node and replaces that code with 0xC0000409. `status` runs against a
 * loopback stand-in for IMS and the DGR API that answers with chunked
 * transfer encoding — the encoding both hosts use for their error replies,
 * and the one under which that abort shows; Content-Length replies hide it.
 * A preload sends the CLI's fetches for those two hosts to the stand-in. The
 * entry point is bundled from source into the repo's own
 * `node_modules/.cache`, beside the dependencies it requires at run time, so
 * the test needs no prior build and always runs the current source.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import {
  createServer,
  get,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, test } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRELOAD = join(REPO, 'test', 'cli', 'fixtures', 'loopback-fetch.cjs');
const STATUS = { jobId: 'job-1', status: 'succeeded', outputs: [] };

let buildDir: string;
let cli: string;
let cwd: string;
let server: Server;
let port: number;

beforeAll(async () => {
  const cache = join(REPO, 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  buildDir = mkdtempSync(join(cache, 'dgr-cli-process-'));
  cli = join(buildDir, 'cli.cjs');
  await build({
    entryPoints: [join(REPO, 'src', 'cli.ts')],
    outfile: cli,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    packages: 'external',
    logLevel: 'silent',
  });
  // An empty working directory: the entry point loads a `.env` from its cwd.
  cwd = mkdtempSync(join(tmpdir(), 'dgr-cli-process-cwd-'));
  server = createServer(answer);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no loopback port');
  port = address.port;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/**
 * IMS's token endpoint and DGR's status endpoint. Each reply calls
 * `writeHead()` before the body is known, so Node sends it chunked.
 */
function answer(req: IncomingMessage, res: ServerResponse): void {
  req.resume();
  req.on('end', () => {
    const [host = '', ...rest] = (req.url ?? '/').slice(1).split('/');
    const route = `${req.method ?? ''} ${host}/${rest.join('/')}`;
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (route === 'POST ims-na1.adobelogin.com/ims/token/v3') {
      reply(200, { access_token: 'PROCESS_TEST_TOKEN', token_type: 'bearer', expires_in: 86_399 });
    } else if (route === 'GET audio-video-api.adobe.io/v1/status/job-1') {
      reply(200, STATUS);
    } else if (route === 'GET audio-video-api.adobe.io/v1/status/missing') {
      reply(404, { message: 'job not found' }, { 'x-request-id': 'req-missing' });
    } else {
      reply(404, { message: `the loopback stand-in has no route for ${route}` });
    }
  });
}

interface CliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Runs the bundled entry point with `args`, credentials in its environment and the loopback preload. */
function runCli(args: readonly string[]): Promise<CliRun> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['NODE_OPTIONS', 'NODE_V8_COVERAGE', 'DGR_STORAGE', 'IMS_OAUTH_S2S_SCOPES']) {
    delete env[name];
  }
  env.IMS_OAUTH_S2S_CLIENT_ID = 'process-test-id';
  env.IMS_OAUTH_S2S_CLIENT_SECRET = 'process-test-secret';
  env.DGR_TEST_STUB_PORT = String(port);
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--require', PRELOAD, cli, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', fail);
    child.on('close', (code, signal) => done({ code, signal, stdout, stderr }));
  });
}

/** Asserts the process exited with `code` on its own, printing nothing to stderr. */
function expectExited(run: CliRun, code: number): void {
  expect(run.code, `exit code (stderr: ${JSON.stringify(run.stderr)})`).toBe(code);
  expect(run.signal).toBeNull();
  expect(run.stderr).toBe('');
}

function documents(stdout: string): unknown[] {
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown);
}

test('the loopback stand-in answers with chunked transfer encoding', async () => {
  const encoding = await new Promise<string | undefined>((done, fail) => {
    get(`http://127.0.0.1:${port}/audio-video-api.adobe.io/v1/status/job-1`, (res) => {
      res.resume();
      res.on('end', () => done(res.headers['transfer-encoding']));
    }).on('error', fail);
  });
  expect(encoding).toBe('chunked');
});

test('status --json exits 0 with exactly one JSON document on stdout, run after run', async () => {
  for (let run = 0; run < 3; run += 1) {
    const result = await runCli(['status', 'job-1', '--json']);
    expectExited(result, 0);
    expect(documents(result.stdout)).toEqual([{ ok: true, job: STATUS }]);
  }
}, 30_000);

test('a status --json the service answers 404 exits 5 with exactly one failure document', async () => {
  const result = await runCli(['status', 'missing', '--json']);
  expectExited(result, 5);
  const docs = documents(result.stdout);
  expect(docs).toHaveLength(1);
  expect(docs[0]).toMatchObject({
    ok: false,
    error: { code: 'http_404', requestId: 'req-missing' },
  });
}, 30_000);
