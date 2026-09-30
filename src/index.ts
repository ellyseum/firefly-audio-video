import { Asset } from './core/asset.js';
import { brandClass } from './core/brand.js';

export const VERSION = '0.1.0'; // x-release-please-version

export {
  configure,
  resetDefaultClient,
  render,
  describe,
  listPresets,
  status,
  cancel,
  stage,
} from './dgr/default-client.js';
export { createClient } from './dgr/client.js';
export type {
  Client,
  ClientConfig,
  DescribeOptions,
  PresetSummary,
  RenderJob,
  RenderOptions,
  RequestOptions,
  StageOptions,
} from './dgr/client.js';
export type { RenderBuilder, RenderBuilderOptions } from './dgr/builder.js';
export type {
  DescribeInput,
  TemplateControl,
  TemplateDescription,
  TemplateFont,
} from './dgr/describe.js';

export type {
  RenderSpec,
  RenderRequest,
  TemplateSource,
  RenderRequestOutput,
  RenderOutput,
  RenderVariable,
  PresetRef,
  PresetRefInput,
  EncodeConfig,
  PresetName,
  Codec,
  Chroma,
  BitDepth,
  Bitrate,
} from './dgr/schemas.js';

export { Preset, presets, encode, resize, toPreset } from './dgr/preset.js';
export type { PresetInput, PresetJSON, PresetKind, ResizeTarget } from './dgr/preset.js';

export { AudioVideoError } from './core/errors.js';
export type { AudioVideoErrorOptions, AudioVideoErrorJSON } from './core/errors.js';

export type { JobItemLike, JobMeta, JobStatusLike, PollInterval } from './core/job.js';
export type { JobHandle } from './core/pooled-job.js';

// Every exported class answers `instanceof` for an instance either of the package's builds made;
// see core/brand.ts. Asset is branded where the package exports it.
brandClass(Asset, 'Asset');
export { Asset };
export type { AssetJSON, AssetOptions, AssetReadOptions, ResolveAs } from './core/asset.js';

export { ClientCredentialsProvider } from './core/auth.js';
export type { TokenProvider, ClientCredentials } from './core/auth.js';

export { rotatingFileLogger, stdoutJsonLogger } from './core/logging.js';
export type {
  Logger,
  LogLevel,
  LogRecord,
  LoggingOption,
  RotatingFileLoggerOptions,
  StdoutJsonLoggerOptions,
} from './core/logging.js';

export { InMemoryPool, DEFAULT_CONCURRENCY } from './core/pool.js';
export type { InMemoryPoolOptions, PoolBackend } from './core/pool.js';

export { normalizeAsset, PassthroughStorageProvider } from './core/storage.js';
export type { StageInput, StorageProvider } from './core/storage.js';
export { AioFilesStorageProvider } from './storage/aio-files.js';
export type {
  AioFilesClient,
  AioFilesModule,
  AioFilesStorageProviderOptions,
} from './storage/aio-files.js';
export { AzureBlobStorageProvider } from './storage/azure.js';
export type {
  AzureBlobModule,
  AzureBlobServiceClient,
  AzureBlobStorageProviderOptions,
  AzureBlockBlobClient,
  AzureContainerClient,
} from './storage/azure.js';
export { S3StorageProvider } from './storage/s3.js';
export type {
  S3ClientLike,
  S3ClientModule,
  S3Credentials,
  S3PresignerModule,
  S3StorageProviderOptions,
} from './storage/s3.js';
