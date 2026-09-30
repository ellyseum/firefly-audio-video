/**
 * An SDK error that reaches Node's own crash printer — a rejection nobody
 * handled — prints no secret. That printer shows an error's `cause` chain
 * and ignores the custom inspect hook `AudioVideoError` defines, so a cause
 * kept raw would print a presigned URL whole. Each case runs in a child
 * process that crashes on its unhandled rejection, and its stderr must show
 * the error and the text of its cause, never the signature that text held.
 * The package is bundled from source into the repo's own
 * `node_modules/.cache`, beside the dependencies it requires at run time, so
 * the test needs no prior build and always runs the current source.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, test } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let buildDir: string;
let bundle: string;

beforeAll(async () => {
  const cache = join(REPO, 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  buildDir = mkdtempSync(join(cache, 'fav-crash-print-'));
  bundle = join(buildDir, 'index.cjs');
  await build({
    entryPoints: [join(REPO, 'src', 'index.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    packages: 'external',
    logLevel: 'silent',
  });
}, 60_000);

afterAll(() => {
  rmSync(buildDir, { recursive: true, force: true });
});

/** Runs `body` in a child process with the bundled SDK loaded as `sdk`; returns its exit status and stderr. */
function crash(name: string, body: string): { status: number | null; stderr: string } {
  const script = join(buildDir, `${name}.cjs`);
  writeFileSync(script, `const sdk = require(${JSON.stringify(bundle)});\n${body}\n`);
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30_000 });
  return { status: run.status, stderr: run.stderr };
}

test("a custom storage provider's failure crashes without printing the signature its error held", () => {
  const { status, stderr } = crash(
    'storage',
    `
const client = sdk.createClient({
  clientId: 'crash-client',
  tokenProvider: { getAccessToken: async () => 'crash-token' },
  logging: false,
  storage: {
    stageRead: async () => {
      throw new Error(
        'upload refused by https://acct.blob.core.windows.net/c/in.mogrt?sv=2026&sig=CUSTOM_PROVIDER_SIG',
      );
    },
    allocateOutput: async () => ({ writeUrl: 'https://example.test/w', readUrl: 'https://example.test/r' }),
  },
});
void client.stage(Buffer.from('capsule bytes'));
`,
  );

  // The rejection went unhandled, and the crash print shows the error and its cause's text.
  expect(status).not.toBe(0);
  expect(stderr).toContain('Staging the input failed.');
  expect(stderr).toContain('upload refused by https://acct.blob.core.windows.net/c/in.mogrt');
  expect(stderr).not.toContain('CUSTOM_PROVIDER_SIG');
});

test("an IMS failure crashes without printing the signature the wrapped provider's error held", () => {
  const { status, stderr } = crash(
    'auth',
    `
// The wrapped IMS provider logs its own error through console.error; only the crash print is checked.
console.error = () => {};
globalThis.fetch = async () => {
  throw new TypeError('fetch failed', {
    cause: new Error('proxy https://proxy.example/connect?sig=AUTH_VENDOR_SIG refused the connection'),
  });
};
const client = sdk.createClient({ clientId: 'crash-client', clientSecret: 'crash-secret', logging: false });
void client.listPresets();
`,
  );

  expect(status).not.toBe(0);
  expect(stderr).toContain('Failed to obtain an access token');
  expect(stderr).toContain('proxy https://proxy.example/connect');
  expect(stderr).not.toContain('AUTH_VENDOR_SIG');
});
