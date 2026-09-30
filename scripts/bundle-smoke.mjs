#!/usr/bin/env node
/**
 * Bundles an application that imports the BUILT package — `dist/`, reached
 * through the package's own `exports` map — the way an App Builder action is
 * bundled, every dependency inlined, with none of the storage providers'
 * optional peer dependencies installed. The bundle must build. Then it runs
 * from a directory where no package resolves, and every storage provider
 * must reject `missing_peer_dependency` naming its `npm install` command.
 *
 * A peer imported by name anywhere in the built code fails the bundle here,
 * exactly as it fails the build of an application that never installed it.
 *
 * Usage: `node scripts/bundle-smoke.mjs` after `npm run build`. The bundles
 * are written to a directory under the OS temp directory, reused per
 * checkout, and printed.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const PEERS = Object.keys(pkg.peerDependencies ?? {});
const OUT = join(
  tmpdir(),
  `${pkg.name}-bundle-smoke-${createHash('sha256').update(ROOT).digest('hex').slice(0, 12)}`,
);

/** Every storage provider, the peer it loads, and options that construct it offline. */
const PROVIDERS = [
  {
    name: 'AioFilesStorageProvider',
    peer: '@adobe/aio-lib-files',
    options: { namespace: 'bundle-smoke-ns', auth: 'bundle-smoke-auth' },
  },
  {
    name: 'S3StorageProvider',
    peer: '@aws-sdk/client-s3',
    options: { bucket: 'bundle-smoke-bucket', region: 'us-east-1' },
  },
  {
    name: 'AzureBlobStorageProvider',
    peer: '@azure/storage-blob',
    options: { container: 'bundle-smoke', connectionString: 'UseDevelopmentStorage=true' },
  },
];

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

/** The file the package's `exports` map gives `condition` (`import` or `require`). */
function exported(condition) {
  const target = pkg.exports?.['.']?.[condition]?.default;
  if (typeof target !== 'string') throw new Error(`package.json exports has no ${condition} entry`);
  return join(ROOT, target);
}

/**
 * Resolves the package name to its built entry through the `exports` map, and
 * fails the bundle on any import of a peer: the resolution an application
 * that installed this package and none of its optional peers would see.
 */
function builtPackageWithoutPeers() {
  const name = new RegExp(`^${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  return {
    name: 'built-package-without-peers',
    setup(bundle) {
      bundle.onResolve({ filter: name }, (args) => ({
        path: exported(args.kind === 'require-call' ? 'require' : 'import'),
      }));
      bundle.onResolve({ filter: /.*/ }, (args) => {
        const peer = PEERS.find(
          (peerName) => args.path === peerName || args.path.startsWith(`${peerName}/`),
        );
        return peer === undefined ? undefined : { errors: [{ text: `${peer} is not installed` }] };
      });
    },
  };
}

/** Bundles `contents` as an application entry, every dependency but the peers inlined. */
function bundle(contents, format, minify = false) {
  return build({
    stdin: { contents, resolveDir: OUT, loader: 'js', sourcefile: 'app.js' },
    bundle: true,
    platform: 'node',
    format,
    minify,
    write: false,
    logLevel: 'silent',
    plugins: [builtPackageWithoutPeers()],
  });
}

/** The application: constructs every provider, stages bytes through each, and prints each outcome as JSON. */
function application(format) {
  const names = ['AudioVideoError', ...PROVIDERS.map(({ name }) => name)].join(', ');
  const load =
    format === 'esm'
      ? `import { ${names} } from '${pkg.name}';`
      : `const { ${names} } = require('${pkg.name}');`;
  const body = `
globalThis.fetch = async () => { throw new Error('the bundle made a network call'); };
const providers = ${JSON.stringify(PROVIDERS.map(({ name, options }) => ({ name, options })))};
const classes = { ${PROVIDERS.map(({ name }) => name).join(', ')} };
const outcomes = [];
for (const { name, options } of providers) {
  const provider = new classes[name](options);
  const error = await provider.stageRead(Buffer.from('bundle smoke')).then(() => undefined, (e) => e);
  outcomes.push({
    name,
    sdkError: error instanceof AudioVideoError,
    code: error === undefined ? undefined : error.code,
    message: error === undefined ? undefined : String(error.message),
  });
}
process.stdout.write(JSON.stringify(outcomes));
`;
  return format === 'esm' ? `${load}\n${body}` : `${load}\n(async () => {${body}})();`;
}

/** True when `specifier` resolves from `directory`. */
function resolvesFrom(directory, specifier) {
  try {
    createRequire(join(directory, 'resolve-probe.cjs')).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

console.log(`bundle-smoke: node ${process.version} (${process.platform}/${process.arch})`);
console.log(`bundle-smoke: package=${pkg.name}@${pkg.version} peers=${PEERS.join(', ')}`);
console.log(`bundle-smoke: out=${OUT}`);
mkdirSync(OUT, { recursive: true });

await check('the built entries exist — run `npm run build` first', () => {
  for (const condition of ['import', 'require']) {
    if (!existsSync(exported(condition))) throw new Error(`${exported(condition)} is missing`);
  }
});

await check('the guard fails a bundle that imports a peer by its name', async () => {
  const outcome = await bundle(`export const load = () => import('${PEERS[0]}');\n`, 'esm').then(
    () => 'built',
    (error) => String(error.message),
  );
  if (!outcome.includes(`${PEERS[0]} is not installed`)) {
    throw new Error(`the peers-not-installed guard did not fire: ${outcome}`);
  }
});

// A bundle runs only from a directory no peer resolves from: there, a provider
// that found its SDK would reach for real storage instead of reporting it missing.
let runnable = false;
await check('no peer resolves from the directory the bundles run in', () => {
  if (!resolvesFrom(ROOT, 'esbuild') || resolvesFrom(OUT, 'esbuild')) {
    throw new Error('the resolution probe cannot tell the repository from the run directory');
  }
  const resolvable = PEERS.filter((peer) => resolvesFrom(OUT, peer));
  if (resolvable.length > 0) {
    throw new Error(
      `${resolvable.join(', ')} resolves from ${OUT}: a missing peer cannot be shown`,
    );
  }
  runnable = true;
});

for (const [format, minify, file] of [
  ['esm', false, 'app.mjs'],
  ['esm', true, 'app.min.mjs'],
  ['cjs', false, 'app.cjs'],
]) {
  const label = `${format}${minify ? ', minified' : ''}`;
  let written;
  await check(
    `[${label}] an application importing the built package bundles without the peers`,
    async () => {
      const result = await bundle(application(format), format, minify);
      if (result.errors.length > 0) throw new Error(JSON.stringify(result.errors));
      const code = result.outputFiles[0]?.text ?? '';
      for (const peer of PEERS) {
        if (!code.includes(`"${peer}"`))
          throw new Error(`the bundle does not name ${peer} as a value`);
      }
      written = join(OUT, file);
      writeFileSync(written, code);
    },
  );
  await check(
    `[${label}] run from the bundle, every provider rejects missing_peer_dependency naming its install command`,
    () => {
      if (written === undefined) throw new Error('the bundle was not written');
      if (!runnable) throw new Error('not run: the run directory is not free of peers');
      const stdout = execFileSync(process.execPath, [written], {
        cwd: OUT,
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: '' },
      });
      const outcomes = JSON.parse(stdout);
      for (const { name, peer } of PROVIDERS) {
        const outcome = outcomes.find((entry) => entry.name === name);
        if (
          outcome?.sdkError !== true ||
          outcome.code !== 'missing_peer_dependency' ||
          !outcome.message.includes(`npm install ${peer}`)
        ) {
          throw new Error(`${name}: ${JSON.stringify(outcome)}`);
        }
      }
    },
  );
}

console.log(
  `bundle-smoke: ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`,
);
process.exitCode = failures === 0 ? 0 : 1;
