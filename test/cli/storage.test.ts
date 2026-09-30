import { expect, test } from 'vitest';
import { AudioVideoError } from '../../src/core/errors.js';
import { AioFilesStorageProvider } from '../../src/storage/aio-files.js';
import { AzureBlobStorageProvider } from '../../src/storage/azure.js';
import { S3StorageProvider } from '../../src/storage/s3.js';
import {
  buildStorageProvider,
  parseStorageUri,
  resolveStorage,
  storageSetting,
  type StorageDescriptor,
} from '../../src/cli/storage.js';

/** An account key, and a connection string carrying it — a value that must never be echoed. */
const ACCOUNT_KEY = 'U1RPUkFHRV9LRVlfTVVTVF9ORVZFUl9BUFBFQVI=';
const CONNECTION_STRING =
  `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${ACCOUNT_KEY};` +
  'EndpointSuffix=core.windows.net';

async function rejection(fn: () => unknown): Promise<AudioVideoError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AudioVideoError);
    return error as AudioVideoError;
  }
  throw new Error('expected a rejection');
}

test('aio-files parses to the bare descriptor', () => {
  expect(parseStorageUri('aio-files', '--storage')).toEqual({ kind: 'aio-files' });
});

test('s3:// parses the bucket and drops a leading slash from the prefix', () => {
  expect(parseStorageUri('s3://my-bucket', '--storage')).toEqual({
    kind: 's3',
    bucket: 'my-bucket',
  });
  expect(parseStorageUri('s3://my-bucket/renders', '--storage')).toEqual({
    kind: 's3',
    bucket: 'my-bucket',
    prefix: 'renders',
  });
  expect(parseStorageUri('s3://my-bucket/renders/nested/', '--storage')).toEqual({
    kind: 's3',
    bucket: 'my-bucket',
    prefix: 'renders/nested/',
  });
});

test('azure:// parses the container and an optional prefix', () => {
  expect(parseStorageUri('azure://my-container', 'DGR_STORAGE')).toEqual({
    kind: 'azure',
    container: 'my-container',
  });
  expect(parseStorageUri('azure://my-container/renders', 'DGR_STORAGE')).toEqual({
    kind: 'azure',
    container: 'my-container',
    prefix: 'renders',
  });
});

test('the scheme is matched case-insensitively', () => {
  expect(parseStorageUri('S3://my-bucket', '--storage')).toEqual({
    kind: 's3',
    bucket: 'my-bucket',
  });
  expect(parseStorageUri('AZURE://my-container', '--storage')).toEqual({
    kind: 'azure',
    container: 'my-container',
  });
});

test('a value with no scheme names its source and says it has no scheme, never the value', async () => {
  for (const source of ['--storage', 'DGR_STORAGE'] as const) {
    const error = await rejection(() => parseStorageUri('not-a-uri-at-all', source));
    expect(error.code).toBe('invalid_argument');
    expect(error.message).toContain(`${source} must be`);
    expect(error.message).toContain('the value given has no scheme');
    expect(error.message).not.toContain('not-a-uri-at-all');
  }
});

test('an Azure connection string given as the storage URI is never echoed, from either source', async () => {
  for (const source of ['--storage', 'DGR_STORAGE'] as const) {
    const error = await rejection(() => parseStorageUri(CONNECTION_STRING, source));
    expect(error.message).toContain(`${source} must be`);
    expect(error.message).toContain('the value given has no scheme');
    expect(error.message).not.toContain(ACCOUNT_KEY);
    expect(error.message).not.toContain('AccountKey');
    expect(error.message).not.toContain('AccountName');
  }
});

test('an unknown scheme is named with its source, and nothing after the scheme is echoed', async () => {
  const error = await rejection(() =>
    parseStorageUri('gcs://secret-bucket/private-prefix', 'DGR_STORAGE'),
  );
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('DGR_STORAGE must be');
  expect(error.message).toContain("the value given has the scheme 'gcs'");
  expect(error.message).not.toContain('secret-bucket');
  expect(error.message).not.toContain('private-prefix');
});

test('an s3:// or azure:// value the URL parser refuses names the scheme, never the value', async () => {
  const error = await rejection(() => parseStorageUri('s3://secret bucket', '--storage'));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('the value given is not a valid s3:// URI');
  expect(error.message).not.toContain('secret bucket');
});

test('s3:// or azure:// with no host is invalid_argument', async () => {
  expect((await rejection(() => parseStorageUri('s3://', '--storage'))).code).toBe(
    'invalid_argument',
  );
  expect((await rejection(() => parseStorageUri('azure://', 'DGR_STORAGE'))).code).toBe(
    'invalid_argument',
  );
});

test('--storage wins over DGR_STORAGE, and is named as the source', () => {
  expect(storageSetting('s3://flag-bucket', { DGR_STORAGE: 'azure://env-container' })).toEqual({
    uri: 's3://flag-bucket',
    source: '--storage',
  });
});

test('DGR_STORAGE is the setting when --storage is absent or blank, and is named as the source', () => {
  const env = { DGR_STORAGE: 'azure://env-container' };
  const fromEnv = { uri: 'azure://env-container', source: 'DGR_STORAGE' };
  expect(storageSetting(undefined, env)).toEqual(fromEnv);
  expect(storageSetting('   ', env)).toEqual(fromEnv);
});

test('there is no storage setting when neither --storage nor DGR_STORAGE holds a value', () => {
  expect(storageSetting(undefined, {})).toBeUndefined();
  expect(storageSetting('', { DGR_STORAGE: ' ' })).toBeUndefined();
});

test('buildStorageProvider builds an AioFilesStorageProvider for aio-files', () => {
  const provider = buildStorageProvider({ kind: 'aio-files' }, {});
  expect(provider).toBeInstanceOf(AioFilesStorageProvider);
});

test('buildStorageProvider builds an S3StorageProvider, region from --region over AWS_REGION over AWS_DEFAULT_REGION', () => {
  const descriptor: StorageDescriptor = { kind: 's3', bucket: 'b', prefix: 'p' };
  expect(buildStorageProvider(descriptor, {})).toBeInstanceOf(S3StorageProvider);
  expect(
    buildStorageProvider(descriptor, { AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-west-2' }),
  ).toBeInstanceOf(S3StorageProvider);
  expect(
    buildStorageProvider(descriptor, { AWS_DEFAULT_REGION: 'us-west-2' }, 'eu-west-1'),
  ).toBeInstanceOf(S3StorageProvider);
});

test('buildStorageProvider builds an AzureBlobStorageProvider from AZURE_STORAGE_CONNECTION_STRING', () => {
  const provider = buildStorageProvider(
    { kind: 'azure', container: 'c' },
    { AZURE_STORAGE_CONNECTION_STRING: 'AccountName=a;AccountKey=abcd' },
  );
  expect(provider).toBeInstanceOf(AzureBlobStorageProvider);
});

test('buildStorageProvider refuses azure:// with no AZURE_STORAGE_CONNECTION_STRING', async () => {
  const descriptor: StorageDescriptor = { kind: 'azure', container: 'c' };
  const error = await rejection(() => buildStorageProvider(descriptor, {}));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('AZURE_STORAGE_CONNECTION_STRING');
});

test('buildStorageProvider treats a blank AZURE_STORAGE_CONNECTION_STRING as absent', async () => {
  const error = await rejection(() =>
    buildStorageProvider(
      { kind: 'azure', container: 'c' },
      { AZURE_STORAGE_CONNECTION_STRING: '   ' },
    ),
  );
  expect(error.code).toBe('invalid_argument');
});

test('resolveStorage composes parseStorageUri and buildStorageProvider', () => {
  expect(resolveStorage({ uri: 's3://bucket', source: '--storage' }, {})).toBeInstanceOf(
    S3StorageProvider,
  );
  expect(resolveStorage({ uri: 'aio-files', source: 'DGR_STORAGE' }, {})).toBeInstanceOf(
    AioFilesStorageProvider,
  );
});

test('resolveStorage propagates a parse failure, naming the setting source', async () => {
  const error = await rejection(() => resolveStorage({ uri: 'bogus', source: 'DGR_STORAGE' }, {}));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('DGR_STORAGE must be');
});
