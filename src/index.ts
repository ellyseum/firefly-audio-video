export const VERSION = '0.1.0';

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
export type { TemplateSource } from './dgr/render.js';

export type {
  RenderSpec,
  RenderRequest,
  RenderRequestOutput,
  RenderOutput,
  RenderVariable,
  PresetRef,
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

export { AsyncJob } from './core/job.js';
export type { JobItemLike, JobMeta, JobStatusLike, PollInterval } from './core/job.js';

export { Asset } from './core/asset.js';
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

export type { StageInput, StorageProvider } from './core/storage.js';
