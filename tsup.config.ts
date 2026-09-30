import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  shims: true,
  target: 'es2022',
  // The storage providers' SDKs are optional peers, imported by name at run time.
  external: [
    '@adobe/aio-lib-files',
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
    '@azure/storage-blob',
  ],
});
