import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { expect, test } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The storage providers' SDKs: optional peers an application may never install. */
const PEERS = [
  '@adobe/aio-lib-files',
  '@aws-sdk/client-s3',
  '@aws-sdk/s3-request-presigner',
  '@azure/storage-blob',
];

/**
 * Makes esbuild resolve the SDK as it would in an application that installed
 * none of the peers: resolving a peer by name fails the bundle, while every
 * other package is left external so only this SDK's own code is bundled.
 */
function peersNotInstalled(): Plugin {
  return {
    name: 'peers-not-installed',
    setup(bundle) {
      bundle.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return undefined;
        const peer = PEERS.find((name) => args.path === name || args.path.startsWith(`${name}/`));
        if (peer !== undefined) return { errors: [{ text: `${peer} is not installed` }] };
        const bare = !/^(?:\.|\/|[A-Za-z]:[\\/]|node:)/.test(args.path);
        return bare ? { path: args.path, external: true } : undefined;
      });
    },
  };
}

/** Bundles `contents` as an application entry beside the repository root. */
function bundleEntry(contents: string, format: 'esm' | 'cjs') {
  return build({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'app.ts' },
    bundle: true,
    platform: 'node',
    format,
    write: false,
    logLevel: 'silent',
    plugins: [peersNotInstalled()],
  });
}

test('an application bundle of the SDK builds with none of the storage peers installed', async () => {
  for (const format of ['esm', 'cjs'] as const) {
    const result = await build({
      entryPoints: [join(ROOT, 'src/index.ts')],
      bundle: true,
      platform: 'node',
      format,
      write: false,
      logLevel: 'silent',
      plugins: [peersNotInstalled()],
    });
    expect(result.errors).toEqual([]);
  }
});

test('the peer loader bundles with every peer name, keeping the ignore comments webpack and Vite read', async () => {
  const entry =
    "import { importModule } from './src/storage/peer.ts';\n" +
    `export const load = () => Promise.all(${JSON.stringify(PEERS)}.map((name) => importModule(name)));\n`;
  for (const format of ['esm', 'cjs'] as const) {
    const result = await bundleEntry(entry, format);
    expect(result.errors).toEqual([]);
    const code = result.outputFiles[0]?.text ?? '';
    expect(code).toContain('webpackIgnore: true');
    expect(code).toContain('@vite-ignore');
  }
});

test('the check fails a bundle that imports a missing peer by its literal name', async () => {
  const entry = "export const load = () => import('@aws-sdk/client-s3');\n";
  await expect(bundleEntry(entry, 'esm')).rejects.toThrow(/@aws-sdk\/client-s3 is not installed/);
});
