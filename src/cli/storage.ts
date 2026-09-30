/**
 * `--storage <uri>` (or `DGR_STORAGE`) to a real {@link StorageProvider}, in
 * two steps: {@link parseStorageUri} is pure — a string in, a
 * {@link StorageDescriptor} or a thrown {@link AudioVideoError} out, nothing
 * constructed — and {@link buildStorageProvider} builds the provider from a
 * descriptor plus whatever the environment supplies. Cloud credentials never
 * come from a flag: S3 uses the AWS SDK's own credential chain, and Azure
 * reads its connection string only from `AZURE_STORAGE_CONNECTION_STRING`,
 * since that string carries the account key.
 */

import type { StorageProvider } from '../core/storage.js';
import { AioFilesStorageProvider } from '../storage/aio-files.js';
import { AzureBlobStorageProvider } from '../storage/azure.js';
import { S3StorageProvider } from '../storage/s3.js';
import { invalidArgument } from './errors.js';
import type { CliEnv } from './runtime.js';
import { firstNonEmpty } from './util.js';

/** What a `--storage` URI names, before any provider is built. */
export type StorageDescriptor =
  | { readonly kind: 'aio-files' }
  | { readonly kind: 's3'; readonly bucket: string; readonly prefix?: string }
  | { readonly kind: 'azure'; readonly container: string; readonly prefix?: string };

const USAGE =
  "--storage must be 's3://<bucket>[/<prefix>]', 'azure://<container>[/<prefix>]', or 'aio-files'";

/**
 * Parses a `--storage` value into a {@link StorageDescriptor}. `aio-files` is
 * the bare keyword; `s3://` and `azure://` name a bucket or container and an
 * optional path prefix. Pure: never touches the filesystem, the network, or
 * an environment variable.
 *
 * @throws {@link AudioVideoError} `invalid_argument` for anything else, an
 *   `s3://`/`azure://` URI with no bucket or container, or an unknown scheme.
 */
export function parseStorageUri(uri: string): StorageDescriptor {
  if (uri === 'aio-files') return { kind: 'aio-files' };
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw invalidArgument(`${USAGE}; got ${JSON.stringify(uri)}.`);
  }
  const prefix = parsed.pathname.replace(/^\/+/, '');
  if (parsed.protocol === 's3:') {
    if (parsed.hostname === '') throw invalidArgument(`${USAGE}: 's3://' must name a bucket.`);
    return prefix === ''
      ? { kind: 's3', bucket: parsed.hostname }
      : { kind: 's3', bucket: parsed.hostname, prefix };
  }
  if (parsed.protocol === 'azure:') {
    if (parsed.hostname === '')
      throw invalidArgument(`${USAGE}: 'azure://' must name a container.`);
    return prefix === ''
      ? { kind: 'azure', container: parsed.hostname }
      : { kind: 'azure', container: parsed.hostname, prefix };
  }
  throw invalidArgument(`${USAGE}; got scheme '${parsed.protocol}'.`);
}

/**
 * Builds the {@link StorageProvider} a {@link StorageDescriptor} names.
 * `regionOverride` (the `--region` flag) wins over `AWS_REGION`, which wins
 * over `AWS_DEFAULT_REGION`; neither is required, since the S3 client falls
 * back to the AWS SDK's own region resolution. Construction never touches
 * the network — nothing here uploads or presigns anything.
 *
 * @throws {@link AudioVideoError} `invalid_argument` for `azure://` storage
 *   with no `AZURE_STORAGE_CONNECTION_STRING` in `env`.
 */
export function buildStorageProvider(
  descriptor: StorageDescriptor,
  env: CliEnv,
  regionOverride?: string,
): StorageProvider {
  switch (descriptor.kind) {
    case 'aio-files':
      return new AioFilesStorageProvider();
    case 's3': {
      const region = firstNonEmpty(regionOverride, env.AWS_REGION, env.AWS_DEFAULT_REGION);
      return new S3StorageProvider({
        bucket: descriptor.bucket,
        ...(descriptor.prefix !== undefined ? { prefix: descriptor.prefix } : {}),
        ...(region !== undefined ? { region } : {}),
      });
    }
    case 'azure': {
      const connectionString = firstNonEmpty(env.AZURE_STORAGE_CONNECTION_STRING);
      if (connectionString === undefined) {
        throw invalidArgument(
          "'azure://' storage requires AZURE_STORAGE_CONNECTION_STRING in the environment: " +
            'the connection string carries the account key and is never accepted as a flag.',
        );
      }
      return new AzureBlobStorageProvider({
        container: descriptor.container,
        ...(descriptor.prefix !== undefined ? { prefix: descriptor.prefix } : {}),
        connectionString,
      });
    }
  }
}

/** {@link parseStorageUri} then {@link buildStorageProvider} — the whole `--storage` resolution. */
export function resolveStorage(uri: string, env: CliEnv, regionOverride?: string): StorageProvider {
  return buildStorageProvider(parseStorageUri(uri), env, regionOverride);
}
