#!/usr/bin/env node
/**
 * Exercises the built package (`dist/`) on the running Node binary, never
 * `src/`. A dual-published package can typecheck and unit-test cleanly while
 * its actual artifact is broken for a consumer on an older supported Node
 * major — a missing export from a bundler misconfiguration, or a runtime
 * feature the target major lacks. This script is the check that would have
 * caught that, run with zero dependencies so it works on every Node major
 * the package claims to support, long before the dev toolchain itself could
 * even be installed there.
 *
 * Usage: `node scripts/runtime-smoke.mjs [distDir]`
 * `distDir` defaults to the `dist/` next to this script's own repo; pass an
 * alternate path to smoke-test a different build (used to prove this script
 * fails legibly against a broken one).
 */

import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ? resolve(process.argv[2]) : join(here, '..', 'dist');

const FAKE_CLIENT_ID = 'runtime-smoke-client-id';
const FAKE_CLIENT_SECRET = 'runtime-smoke-fake-secret-do-not-use';
const FAKE_SIGNATURE = 'RUNTIME_SMOKE_SIGNATURE_MUST_NOT_LEAK';

let failures = 0;

/** Runs `fn`, printing a TAP-style ok/not-ok line; never throws. */
async function check(label, fn) {
  try {
    await fn();
    console.log(`ok - ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`not ok - ${label}`);
    console.error(`    ${err && err.stack ? err.stack.split('\n').join('\n    ') : String(err)}`);
  }
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`);
}

console.log(`runtime-smoke: node ${process.version} (${process.platform}/${process.arch})`);
console.log(`runtime-smoke: dist=${distDir}`);

// --- runtime features the SDK relies on, checked before anything is patched ---

await check('global fetch is available', () => {
  if (typeof fetch !== 'function') throw new Error('globalThis.fetch is missing');
});
await check('AbortSignal.timeout is available', () => {
  if (typeof AbortSignal.timeout !== 'function') throw new Error('AbortSignal.timeout is missing');
});
await check('stream.Readable.fromWeb is available', () => {
  if (typeof Readable.fromWeb !== 'function') throw new Error('Readable.fromWeb is missing');
});
await check('structuredClone is available', () => {
  if (typeof structuredClone !== 'function') throw new Error('structuredClone is missing');
});

// From here on, fetch is replaced with a stub that throws — every remaining
// check must pass with no network reachable, proving both that importing
// the package has no side effects and that none of the exercised behaviour
// makes a request.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('runtime-smoke made a network call, which it must never do');
};

const nodeRequire = createRequire(import.meta.url);

let cjs;
await check('require() loads the CJS entry (dist/index.cjs)', () => {
  cjs = nodeRequire(join(distDir, 'index.cjs'));
  if (!cjs || typeof cjs.createClient !== 'function') {
    throw new Error('dist/index.cjs did not export createClient');
  }
});

let esm;
await check('import() loads the ESM entry (dist/index.js)', async () => {
  esm = await import(pathToFileURL(join(distDir, 'index.js')).href);
  if (!esm || typeof esm.createClient !== 'function') {
    throw new Error('dist/index.js did not export createClient');
  }
});

/** The same behaviour battery run against both the CJS and the ESM export object. */
async function runBehaviourChecks(mod, label) {
  await check(`[${label}] createClient() builds a client with fake credentials`, () => {
    const client = mod.createClient({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      logging: false,
    });
    for (const method of ['render', 'describe', 'listPresets', 'status', 'cancel', 'stage']) {
      if (typeof client[method] !== 'function') {
        throw new Error(`client.${method} is missing`);
      }
    }
    const seen = `${inspect(client, { depth: 6 })}\n${JSON.stringify(client)}`;
    if (seen.includes(FAKE_CLIENT_SECRET)) {
      throw new Error(
        'the client secret is reachable via util.inspect()/JSON.stringify() on the client',
      );
    }
  });

  await check(`[${label}] a chained preset prints consistent JSON`, () => {
    const preset = mod.presets.hevc4k10bit.with({ frameRate: 24 }).chroma('420');
    const json = preset.toJSON();
    if (!json || typeof json !== 'object' || !json.config || json.config.chroma !== '420') {
      throw new Error(`preset.toJSON() did not reflect the chain: ${JSON.stringify(json)}`);
    }
    assertEqual(
      JSON.parse(preset.toString()),
      json,
      'preset.toString() must match preset.toJSON()',
    );
  });

  await check(`[${label}] InMemoryPool runs tasks under a concurrency bound`, async () => {
    const pool = new mod.InMemoryPool({ concurrency: 2 });
    const results = await Promise.all([1, 2, 3, 4].map((n) => pool.run(async () => n * 2)));
    assertEqual(results, [2, 4, 6, 8], 'pool.run() results');
    await pool.drain();
    if (pool.active !== 0 || pool.queued !== 0) {
      throw new Error(`pool did not settle: active=${pool.active} queued=${pool.queued}`);
    }
  });

  await check(`[${label}] Asset.toJSON() redacts a signed URL and keeps benign params`, () => {
    const asset = new mod.Asset({
      url: `https://example.test/out.mov?sig=${FAKE_SIGNATURE}&rest=keep`,
      meta: { jobId: 'runtime-smoke-job', perItem: [] },
    });
    const json = asset.toJSON();
    if (json.url.includes(FAKE_SIGNATURE)) {
      throw new Error(`Asset.toJSON() leaked the signature: ${json.url}`);
    }
    if (!json.url.includes('rest=keep')) {
      throw new Error(`Asset.toJSON() dropped a benign query param: ${json.url}`);
    }
    if (json.meta.jobId !== 'runtime-smoke-job') {
      throw new Error(`Asset.toJSON() meta mismatch: ${JSON.stringify(json.meta)}`);
    }
  });

  await check(
    `[${label}] normalizeAsset passes a URL through and refuses bytes with no storage`,
    async () => {
      const url = `https://example.test/logo.png?sig=${FAKE_SIGNATURE}`;
      assertEqual(await mod.normalizeAsset(url), url, 'normalizeAsset(url)');
      assertEqual(
        await mod.normalizeAsset(url, new mod.PassthroughStorageProvider()),
        url,
        'normalizeAsset(url, passthrough)',
      );
      const refused = await mod.normalizeAsset(Buffer.from('x')).then(
        () => undefined,
        (err) => err,
      );
      if (!(refused instanceof mod.AudioVideoError) || refused.code !== 'invalid_argument') {
        throw new Error(`a Buffer with no storage did not reject invalid_argument: ${refused}`);
      }
    },
  );

  await check(`[${label}] every storage provider constructs without loading its SDK`, () => {
    for (const { name, options } of STORAGE_PROVIDERS) {
      const provider = new mod[name](options);
      if (
        typeof provider.stageRead !== 'function' ||
        typeof provider.allocateOutput !== 'function'
      ) {
        throw new Error(`${name} does not implement stageRead() and allocateOutput()`);
      }
    }
  });

  for (const { name, peer, options } of STORAGE_PROVIDERS) {
    // Where the peer is installed, using the provider would reach its real SDK; the
    // missing-peer path is exercised wherever it is not, as in the production-only install.
    if (resolvableFromDist(peer)) {
      console.log(`ok - [${label}] ${name} with ${peer} missing # SKIP ${peer} is installed here`);
      continue;
    }
    await check(
      `[${label}] ${name} rejects missing_peer_dependency while ${peer} is missing`,
      async () => {
        const err = await new mod[name](options).allocateOutput().then(
          () => undefined,
          (error) => error,
        );
        if (
          !(err instanceof mod.AudioVideoError) ||
          err.code !== 'missing_peer_dependency' ||
          !err.message.includes(`npm install ${peer}`)
        ) {
          throw new Error(`${name} without ${peer} did not reject missing_peer_dependency: ${err}`);
        }
      },
    );
  }
}

/** Every storage provider the package exports, with options that construct it offline and the peer it loads. */
const STORAGE_PROVIDERS = [
  {
    name: 'AioFilesStorageProvider',
    peer: '@adobe/aio-lib-files',
    options: { namespace: 'runtime-smoke-ns', auth: 'runtime-smoke-auth' },
  },
  {
    name: 'S3StorageProvider',
    peer: '@aws-sdk/client-s3',
    options: { bucket: 'runtime-smoke-bucket', region: 'us-east-1' },
  },
  {
    name: 'AzureBlobStorageProvider',
    peer: '@azure/storage-blob',
    options: { container: 'runtime-smoke', connectionString: 'UseDevelopmentStorage=true' },
  },
];

/** True when `name` resolves from the package being tested — an optional peer that is installed. */
function resolvableFromDist(name) {
  try {
    createRequire(join(distDir, 'index.cjs')).resolve(name);
    return true;
  } catch {
    return false;
  }
}

if (cjs) await runBehaviourChecks(cjs, 'cjs');
else console.error('not ok - [cjs] behaviour checks skipped: the CJS entry did not load');

if (esm) await runBehaviourChecks(esm, 'esm');
else console.error('not ok - [esm] behaviour checks skipped: the ESM entry did not load');

if (!cjs || !esm) failures += 1;

globalThis.fetch = realFetch;

console.log(
  `runtime-smoke: ${failures === 0 ? 'all checks passed' : `${failures} check group(s) failed`}`,
);
process.exitCode = failures === 0 ? 0 : 1;
