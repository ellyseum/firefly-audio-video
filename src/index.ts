export const VERSION = '0.1.0';

export type {
  RenderSpec,
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
export type { JobMeta } from './core/job.js';

export { Asset } from './core/asset.js';
export type { ResolveAs } from './core/asset.js';

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
export type { PoolBackend } from './core/pool.js';
