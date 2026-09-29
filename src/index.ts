export const VERSION = '0.1.0';

export type {
  RenderSpec,
  RenderOutput,
  RenderVariable,
  PresetRef,
  EncodeConfig,
} from './dgr/schemas.js';

export { AudioVideoError } from './core/errors.js';
export type { AudioVideoErrorOptions, AudioVideoErrorJSON } from './core/errors.js';

export { AsyncJob } from './core/job.js';
export type { JobMeta } from './core/job.js';

export { ClientCredentialsProvider } from './core/auth.js';
export type { TokenProvider, ClientCredentials } from './core/auth.js';

export { rotatingFileLogger, stdoutJsonLogger } from './core/logging.js';
export type {
  Logger,
  LogLevel,
  LogRecord,
  LoggingOption,
  RotatingFileLoggerOptions,
} from './core/logging.js';
