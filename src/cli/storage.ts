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

/** What a storage URI names, before any provider is built. */
export type StorageDescriptor =
  | { readonly kind: 'aio-files' }
  | { readonly kind: 's3'; readonly bucket: string; readonly prefix?: string }
  | { readonly kind: 'azure'; readonly container: string; readonly prefix?: string };

/** Where a storage URI came from: the flag, or the environment variable. */
export type StorageSource = '--storage' | 'DGR_STORAGE';

/** A storage URI and where it came from. */
export interface StorageSetting {
  readonly uri: string;
  readonly source: StorageSource;
}

/**
 * The storage URI a command uses: `--storage` when given, else
 * `DGR_STORAGE`, else `undefined`. A blank value counts as absent.
 */
export function storageSetting(flag: string | undefined, env: CliEnv): StorageSetting | undefined {
  const fromFlag = firstNonEmpty(flag);
  if (fromFlag !== undefined) return { uri: fromFlag, source: '--storage' };
  const fromEnv = firstNonEmpty(env.DGR_STORAGE);
  if (fromEnv !== undefined) return { uri: fromEnv, source: 'DGR_STORAGE' };
  return undefined;
}

const FORMS = "'s3://<bucket>[/<prefix>]', 'azure://<container>[/<prefix>]', or 'aio-files'";

/** A URI's scheme: a letter, then letters, digits, `+`, `-` or `.`, up to the first `:`. */
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Parses a storage URI into a {@link StorageDescriptor}. `aio-files` is the
 * bare keyword; `s3://` and `azure://` name a bucket or container and an
 * optional path prefix. An error names `source` and the scheme the value
 * has, never the value itself: a connection string given here by mistake
 * carries an account key. Pure: never touches the filesystem, the network,
 * or an environment variable.
 *
 * @throws {@link AudioVideoError} `invalid_argument` for a value with no
 *   scheme or an unknown one, or an `s3://`/`azure://` URI that does not
 *   parse or names no bucket or container.
 */
export function parseStorageUri(uri: string, source: StorageSource): StorageDescriptor {
  if (uri === 'aio-files') return { kind: 'aio-files' };
  const usage = `${source} must be ${FORMS}`;
  const scheme = SCHEME_RE.exec(uri)?.[1]?.toLowerCase();
  if (scheme === undefined) throw invalidArgument(`${usage}; the value given has no scheme.`);
  if (scheme !== 's3' && scheme !== 'azure') {
    throw invalidArgument(`${usage}; the value given has the scheme '${scheme}'.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw invalidArgument(`${usage}; the value given is not a valid ${scheme}:// URI.`);
  }
  const prefix = parsed.pathname.replace(/^\/+/, '');
  if (scheme === 's3') {
    if (parsed.hostname === '') throw invalidArgument(`${usage}: 's3://' must name a bucket.`);
    return prefix === ''
      ? { kind: 's3', bucket: parsed.hostname }
      : { kind: 's3', bucket: parsed.hostname, prefix };
  }
  if (parsed.hostname === '') throw invalidArgument(`${usage}: 'azure://' must name a container.`);
  return prefix === ''
    ? { kind: 'azure', container: parsed.hostname }
    : { kind: 'azure', container: parsed.hostname, prefix };
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

/** {@link parseStorageUri} then {@link buildStorageProvider} — the whole storage resolution. */
export function resolveStorage(
  setting: StorageSetting,
  env: CliEnv,
  regionOverride?: string,
): StorageProvider {
  return buildStorageProvider(parseStorageUri(setting.uri, setting.source), env, regionOverride);
}
