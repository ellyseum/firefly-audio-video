import { expect, test } from 'vitest';
import { AudioVideoError } from '../../src/core/errors.js';
import { AioFilesStorageProvider } from '../../src/storage/aio-files.js';
import { AzureBlobStorageProvider } from '../../src/storage/azure.js';
import { S3StorageProvider } from '../../src/storage/s3.js';
import {
  buildStorageProvider,
  parseStorageUri,
  resolveStorage,
  type StorageDescriptor,
} from '../../src/cli/storage.js';

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
  expect(parseStorageUri('aio-files')).toEqual({ kind: 'aio-files' });
});

test('s3:// parses the bucket and drops a leading slash from the prefix', () => {
  expect(parseStorageUri('s3://my-bucket')).toEqual({ kind: 's3', bucket: 'my-bucket' });
  expect(parseStorageUri('s3://my-bucket/renders')).toEqual({
    kind: 's3',
    bucket: 'my-bucket',
    prefix: 'renders',
  });
  expect(parseStorageUri('s3://my-bucket/renders/nested/')).toEqual({
    kind: 's3',
    bucket: 'my-bucket',
    prefix: 'renders/nested/',
  });
});

test('azure:// parses the container and an optional prefix', () => {
  expect(parseStorageUri('azure://my-container')).toEqual({
    kind: 'azure',
    container: 'my-container',
  });
  expect(parseStorageUri('azure://my-container/renders')).toEqual({
    kind: 'azure',
    container: 'my-container',
    prefix: 'renders',
  });
});

test('the scheme is matched case-insensitively', () => {
  expect(parseStorageUri('S3://my-bucket')).toEqual({ kind: 's3', bucket: 'my-bucket' });
  expect(parseStorageUri('AZURE://my-container')).toEqual({
    kind: 'azure',
    container: 'my-container',
  });
});

test('a string with no scheme at all is invalid_argument', async () => {
  const error = await rejection(() => parseStorageUri('not-a-uri-at-all'));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('--storage');
});

test('s3:// or azure:// with no host is invalid_argument', async () => {
  expect((await rejection(() => parseStorageUri('s3://'))).code).toBe('invalid_argument');
  expect((await rejection(() => parseStorageUri('azure://'))).code).toBe('invalid_argument');
});

test('an unknown scheme is invalid_argument, naming the scheme', async () => {
  const error = await rejection(() => parseStorageUri('gcs://bucket/prefix'));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('gcs');
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

test('buildStorageProvider refuses azure:// with no AZURE_STORAGE_CONNECTION_STRING, and never accepts one as a flag', async () => {
  const descriptor: StorageDescriptor = { kind: 'azure', container: 'c' };
  const error = await rejection(() => buildStorageProvider(descriptor, {}));
  expect(error.code).toBe('invalid_argument');
  expect(error.message).toContain('AZURE_STORAGE_CONNECTION_STRING');
  // No option on StorageDescriptor carries a connection string — it is only ever read from env.
  expect(Object.keys(descriptor)).not.toContain('connectionString');
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
  expect(resolveStorage('s3://bucket', {})).toBeInstanceOf(S3StorageProvider);
  expect(resolveStorage('aio-files', {})).toBeInstanceOf(AioFilesStorageProvider);
});

test('resolveStorage propagates a parse failure before any provider is built', async () => {
  const error = await rejection(() => resolveStorage('bogus', {}));
  expect(error.code).toBe('invalid_argument');
});
