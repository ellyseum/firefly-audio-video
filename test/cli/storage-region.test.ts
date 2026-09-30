/**
 * The options `buildStorageProvider` builds the S3 provider with carry the
 * region `resolveRegion` picks. The provider keeps its region private, so
 * the provider class is replaced here by one that records its options.
 */

import { expect, test, vi } from 'vitest';
import { buildStorageProvider, type StorageDescriptor } from '../../src/cli/storage.js';

vi.mock('../../src/storage/s3.js', () => ({
  S3StorageProvider: class {
    readonly options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
    }
  },
}));

function optionsOf(provider: unknown): Record<string, unknown> {
  return (provider as { options: Record<string, unknown> }).options;
}

test('the S3 provider is built with the region --region, then AWS_REGION, then AWS_DEFAULT_REGION names', () => {
  const descriptor: StorageDescriptor = { kind: 's3', bucket: 'b', prefix: 'p' };
  const env = { AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-west-2' };
  expect(optionsOf(buildStorageProvider(descriptor, env, 'eu-west-1'))).toEqual({
    bucket: 'b',
    prefix: 'p',
    region: 'eu-west-1',
  });
  expect(optionsOf(buildStorageProvider(descriptor, env))).toEqual({
    bucket: 'b',
    prefix: 'p',
    region: 'us-east-1',
  });
  expect(optionsOf(buildStorageProvider(descriptor, { AWS_DEFAULT_REGION: 'us-west-2' }))).toEqual({
    bucket: 'b',
    prefix: 'p',
    region: 'us-west-2',
  });
  expect(optionsOf(buildStorageProvider(descriptor, {}))).toEqual({ bucket: 'b', prefix: 'p' });
});
