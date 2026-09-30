#!/usr/bin/env node
/**
 * Exercises the built package (`dist/`) on the running Node binary, never
 * `src/`. A dual-published package can typecheck and unit-test cleanly while
 * its actual artifact is broken for a consumer on an older supported Node
 * major — a missing export from a bundler misconfiguration, or a runtime
 * feature the target major lacks. This script is the check that would have
 * caught that, run with zero dependencies so it works on every Node major
 * the package claims to support, long before the dev toolchain itself could
 * even be installed there. It loads both builds into one process, as an
 * application with a CommonJS dependency does, and checks that they share
 * one default client and one identity for every exported class.
 *
 * Usage: `node scripts/runtime-smoke.mjs [distDir]`
 * `distDir` defaults to the `dist/` next to this script's own repo; pass an
 * alternate path to smoke-test a different build (used to prove this script
 * fails legibly against a broken one).
 */

import { Console } from 'node:console';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { inspect } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ? resolve(process.argv[2]) : join(here, '..', 'dist');

const FAKE_CLIENT_ID = 'runtime-smoke-client-id';
const FAKE_CLIENT_SECRET = 'runtime-smoke-fake-secret-do-not-use';
const FAKE_SIGNATURE = 'RUNTIME_SMOKE_SIGNATURE_MUST_NOT_LEAK';
const FAKE_RUNTIME_AUTH = 'runtime-smoke-uuid:RUNTIME_SMOKE_RUNTIME_AUTH_MUST_NOT_PRINT';
const FAKE_AWS_SECRET = 'RUNTIME_SMOKE_AWS_SECRET_KEY_MUST_NOT_PRINT';
const FAKE_AWS_SESSION = 'RUNTIME_SMOKE_AWS_SESSION_TOKEN_MUST_NOT_PRINT';
const FAKE_AZURE_KEY = Buffer.from('RUNTIME_SMOKE_AZURE_ACCOUNT_KEY_MUST_NOT_PRINT').toString(
  'base64',
);

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

  await check(
    `[${label}] no storage provider, nor a client using one, prints a credential it holds`,
    () => {
      if (!printedForms({ held: FAKE_AWS_SECRET }).includes(FAKE_AWS_SECRET)) {
        throw new Error('the printed forms checked here do not show even a plain held value');
      }
      for (const { name, options, secrets } of STORAGE_PROVIDERS) {
        const provider = new mod[name](options);
        const client = mod.createClient({
          clientId: FAKE_CLIENT_ID,
          clientSecret: FAKE_CLIENT_SECRET,
          logging: false,
          storage: provider,
        });
        for (const [what, value] of [
          ['provider', provider],
          ['client', client],
        ]) {
          const printed = printedForms(value);
          const shown = secrets.filter((secret) => printed.includes(secret)).length;
          if (shown > 0)
            throw new Error(`${name}: the ${what} printed ${shown} held credential(s)`);
        }
      }
    },
  );

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
    options: { namespace: 'runtime-smoke-ns', auth: FAKE_RUNTIME_AUTH },
    secrets: [FAKE_RUNTIME_AUTH],
  },
  {
    name: 'S3StorageProvider',
    peer: '@aws-sdk/client-s3',
    options: {
      bucket: 'runtime-smoke-bucket',
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'RUNTIMESMOKEACCESSKEYID',
        secretAccessKey: FAKE_AWS_SECRET,
        sessionToken: FAKE_AWS_SESSION,
      },
    },
    secrets: ['RUNTIMESMOKEACCESSKEYID', FAKE_AWS_SECRET, FAKE_AWS_SESSION],
  },
  {
    name: 'AzureBlobStorageProvider',
    peer: '@azure/storage-blob',
    options: {
      container: 'runtime-smoke',
      accountName: 'runtimesmoke',
      accountKey: FAKE_AZURE_KEY,
    },
    secrets: [FAKE_AZURE_KEY],
  },
];

/** Every common printed form of a value: `inspect`, `String`, `JSON.stringify`, a spread copy, and what `console.log` writes. */
function printedForms(value) {
  const written = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      written.push(String(chunk));
      done();
    },
  });
  new Console({ stdout: sink, stderr: sink }).log(value);
  return [
    inspect(value, { depth: 10, showHidden: true }),
    String(value),
    JSON.stringify(value),
    inspect({ ...value }, { depth: 10 }),
    ...written,
  ].join('\n');
}

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

// --- one process, both builds: one default client, one identity for every class ---

/**
 * A fetch stub for the checks that follow: IMS mints a token, the presets
 * listing answers empty, a render submit is accepted and its status succeeds
 * at once. Each request is recorded in `seen` with the x-api-key it carried,
 * a submit with its body too.
 */
function recordingFetch(seen) {
  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : (input.url ?? String(input)));
    if (url.hostname === 'ims-na1.adobelogin.com') {
      seen.push(`ims ${new URLSearchParams(String(init.body)).get('client_id')}`);
      return json(200, {
        access_token: 'runtime-smoke-token',
        token_type: 'bearer',
        expires_in: 86399,
      });
    }
    const key = new Headers(init.headers).get('x-api-key');
    if (url.pathname === '/v1/presets') {
      seen.push(`presets ${key}`);
      return json(200, { items: [] });
    }
    if (url.pathname === '/v1/templates/render') {
      seen.push(`submit ${key} ${init.body}`);
      return json(202, { jobId: 'smoke-job', statusUrl: `${url.origin}/v1/status/smoke-job` });
    }
    if (url.pathname === '/v1/status/smoke-job') {
      return json(200, {
        jobId: 'smoke-job',
        status: 'succeeded',
        outputs: [
          {
            destination: { url: 'https://example.test/out.mov' },
            variationIndex: '0',
            presetIndex: '0',
          },
        ],
      });
    }
    throw new Error(`runtime-smoke made an unexpected request: ${url.href}`);
  };
}

/** A config authenticating with a fixed token, so a request's x-api-key names the tenant. */
function tenant(clientId) {
  return {
    clientId,
    tokenProvider: { getAccessToken: async () => `${clientId}-token` },
    logging: false,
  };
}

/** One instance of every class the package exports, made by `mod`. */
function instancesOf(mod) {
  return [
    ['AudioVideoError', new mod.AudioVideoError({ message: 'runtime smoke', code: 'smoke' })],
    [
      'Asset',
      new mod.Asset({ url: 'https://example.test/a.mov', meta: { jobId: 'j', perItem: [] } }),
    ],
    ['Preset', mod.presets.prores],
    ['InMemoryPool', new mod.InMemoryPool()],
    ['PassthroughStorageProvider', new mod.PassthroughStorageProvider()],
    [
      'ClientCredentialsProvider',
      new mod.ClientCredentialsProvider({
        clientId: FAKE_CLIENT_ID,
        clientSecret: FAKE_CLIENT_SECRET,
      }),
    ],
    ...STORAGE_PROVIDERS.map(({ name, options }) => [name, new mod[name](options)]),
  ];
}

if (cjs && esm) {
  const throwingFetch = globalThis.fetch;
  const savedEnv = {
    id: process.env.IMS_OAUTH_S2S_CLIENT_ID,
    secret: process.env.IMS_OAUTH_S2S_CLIENT_SECRET,
  };
  // An environment credential is present, so a build that ignored the other build's configure()
  // would fall back to it rather than fail.
  process.env.IMS_OAUTH_S2S_CLIENT_ID = 'RUNTIME_SMOKE_ENV_CLIENT';
  process.env.IMS_OAUTH_S2S_CLIENT_SECRET = 'runtime-smoke-env-secret';
  try {
    await check(
      '[cjs+esm] configure() through either build installs the default client the other build calls',
      async () => {
        for (const [through, calledFrom, clientId] of [
          [cjs, esm, 'RUNTIME_SMOKE_TENANT_A'],
          [esm, cjs, 'RUNTIME_SMOKE_TENANT_B'],
        ]) {
          const seen = [];
          globalThis.fetch = recordingFetch(seen);
          through.configure(tenant(clientId));
          await calledFrom.listPresets();
          assertEqual(seen, [`presets ${clientId}`], 'the requests the other build made');
          through.resetDefaultClient();
        }
      },
    );

    await check(
      '[cjs+esm] resetDefaultClient() through either build clears the default client for both',
      async () => {
        const seen = [];
        globalThis.fetch = recordingFetch(seen);
        cjs.configure(tenant('RUNTIME_SMOKE_TENANT_A'));
        esm.resetDefaultClient();
        await cjs.listPresets();
        assertEqual(
          seen,
          ['ims RUNTIME_SMOKE_ENV_CLIENT', 'presets RUNTIME_SMOKE_ENV_CLIENT'],
          'the requests after a reset through the other build',
        );
        cjs.resetDefaultClient();
      },
    );

    await check(
      '[cjs+esm] an error either build throws, and every exported class, is instanceof across the builds',
      async () => {
        for (const [made, other, label] of [
          [cjs, esm, 'cjs'],
          [esm, cjs, 'esm'],
        ]) {
          const thrown = await made.status('').then(
            () => undefined,
            (error) => error,
          );
          if (
            !(thrown instanceof other.AudioVideoError) ||
            !(thrown instanceof made.AudioVideoError)
          ) {
            throw new Error(
              `an error the ${label} build threw is not instanceof both builds' AudioVideoError`,
            );
          }
          for (const [name, instance] of instancesOf(made)) {
            if (!(instance instanceof other[name])) {
              throw new Error(
                `a ${name} the ${label} build made is not instanceof the other build's ${name}`,
              );
            }
          }
          made.resetDefaultClient();
        }
      },
    );

    await check(
      "[cjs+esm] a preset one build made renders through the other build's default client",
      async () => {
        const seen = [];
        globalThis.fetch = recordingFetch(seen);
        cjs.configure(tenant('RUNTIME_SMOKE_TENANT_A'));
        const asset = await esm.render(
          {
            source: 'https://example.test/capsule.mogrt',
            presets: [esm.presets.prores],
            outputs: [{ presetIndex: 0, destination: 'https://example.test/out.mov' }],
          },
          { pollIntervalMs: 0 },
        );
        const submit = seen.find((entry) => entry.startsWith('submit '));
        if (
          submit === undefined ||
          !submit.startsWith('submit RUNTIME_SMOKE_TENANT_A ') ||
          !submit.includes('"presetId":"ffs_video_api_prores"')
        ) {
          throw new Error(`the submit did not carry the tenant and the preset: ${submit}`);
        }
        if (!(asset instanceof esm.Asset) || !(asset instanceof cjs.Asset)) {
          throw new Error("the rendered asset is not instanceof both builds' Asset");
        }
        cjs.resetDefaultClient();
      },
    );

    await check(
      "[cjs+esm] a client one build created serves the other build's calls given as { client }",
      async () => {
        const seen = [];
        globalThis.fetch = recordingFetch(seen);
        await esm.listPresets({ client: cjs.createClient(tenant('RUNTIME_SMOKE_TENANT_C')) });
        assertEqual(seen, ['presets RUNTIME_SMOKE_TENANT_C'], 'the requests the esm build made');
      },
    );
  } finally {
    globalThis.fetch = throwingFetch;
    for (const [name, value] of [
      ['IMS_OAUTH_S2S_CLIENT_ID', savedEnv.id],
      ['IMS_OAUTH_S2S_CLIENT_SECRET', savedEnv.secret],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

globalThis.fetch = realFetch;

const version = cjs?.VERSION ?? esm?.VERSION;
await check('dist/cli.cjs --version prints the package VERSION and exits 0', () => {
  if (version === undefined)
    throw new Error('no loaded entry exposed a VERSION to compare against');
  const result = spawnSync(process.execPath, [join(distDir, 'cli.cjs'), '--version'], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`exited ${result.status}, stderr: ${result.stderr}`);
  }
  const printed = result.stdout.trim();
  if (printed !== version) {
    throw new Error(`expected VERSION ${version}, got ${JSON.stringify(printed)}`);
  }
});

console.log(
  `runtime-smoke: ${failures === 0 ? 'all checks passed' : `${failures} check group(s) failed`}`,
);
process.exitCode = failures === 0 ? 0 : 1;
