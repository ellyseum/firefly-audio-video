/**
 * Loading the SDKs the storage providers use — optional peer dependencies —
 * at run time, by a name no bundler can see: an application bundle that
 * leaves a peer out still builds, and a missing peer surfaces only when the
 * provider that needs it runs, as `missing_peer_dependency`.
 */

import { AudioVideoError } from '../core/errors.js';
import { redactError } from '../core/redact.js';

/** @internal Loads a module by its specifier. */
export type ModuleImporter = (specifier: string) => Promise<unknown>;

/**
 * @internal Imports `specifier` with the runtime's own `import()`. The
 * specifier arrives as a value, never a literal, and the import carries
 * webpack's and Vite's ignore comments: an application bundler must never try
 * to resolve an optional peer at build time, because a bundle without it
 * would then fail to build.
 */
export function importModule(specifier: string): Promise<unknown> {
  return import(/* webpackIgnore: true */ /* @vite-ignore */ specifier);
}

/** @internal An optional peer dependency, and what a caller who lacks it is told. */
export interface Peer {
  /** The package to import, e.g. `'@aws-sdk/client-s3'`. */
  readonly specifier: string;
  /** The provider that needs it, e.g. `'S3StorageProvider'`. */
  readonly provider: string;
  /** The command that installs everything the provider needs. */
  readonly install: string;
  /** The provider option that takes the module itself, for bundled code. */
  readonly option: string;
}

/**
 * @internal Imports `peer` through `importer`.
 *
 * @throws {@link AudioVideoError} `missing_peer_dependency`, naming the
 *   install command, when the module cannot be found; `storage_failed` when
 *   loading it fails in any other way — a test runner's sandbox that refuses
 *   a run-time `import()`, a module that throws while it loads. Either way
 *   the message names the option that takes the module itself, and carries
 *   the loader's error as redacted text; the cause is a redacted copy of it.
 */
export async function loadPeer(
  peer: Peer,
  importer: ModuleImporter = importModule,
): Promise<unknown> {
  try {
    return await importer(peer.specifier);
  } catch (error) {
    const cause = redactError(error);
    const reason = causeText(cause);
    if (isModuleNotFound(error)) {
      throw new AudioVideoError({
        message:
          `${peer.provider} needs ${peer.specifier}, which could not be found (${reason}): ` +
          `install it with \`${peer.install}\`. In bundled code, where it cannot be loaded at ` +
          `run time, pass the module as the ${peer.option} option instead.`,
        code: 'missing_peer_dependency',
        cause,
      });
    }
    throw new AudioVideoError({
      message:
        `Loading ${peer.specifier} for ${peer.provider} failed (${reason}). Pass the module as ` +
        `the ${peer.option} option instead: a module passed in needs no run-time import.`,
      code: 'storage_failed',
      cause,
    });
  }
}

/**
 * @internal The export `name` of a loaded module: its own export, or a
 * property of its default export — the shape `import()` gives a CommonJS
 * module.
 *
 * @throws {@link AudioVideoError} `storage_failed` when the module has neither.
 */
export function exportOf(module: unknown, name: string, peer: Peer): unknown {
  const own = propertyOf(module, name);
  if (own !== undefined) return own;
  const viaDefault = propertyOf(propertyOf(module, 'default'), name);
  if (viaDefault !== undefined) return viaDefault;
  throw new AudioVideoError({
    message: `${peer.specifier} does not export ${name}, which ${peer.provider} needs.`,
    code: 'storage_failed',
  });
}

/** How much of a loader's error a message repeats. */
const CAUSE_LIMIT = 300;

/** A redacted loader error as one line, `name [code]: message`, cut short. */
function causeText(cause: Error): string {
  const code = (cause as Error & { code?: unknown }).code;
  const head = code === undefined ? cause.name : `${cause.name} [${String(code)}]`;
  const text = cause.message === '' ? head : `${head}: ${cause.message}`;
  return text.length > CAUSE_LIMIT ? `${text.slice(0, CAUSE_LIMIT - 3)}...` : text;
}

/** True for the error `import()` (`ERR_MODULE_NOT_FOUND`) or `require()` (`MODULE_NOT_FOUND`) raises for a module it cannot find. */
function isModuleNotFound(error: unknown): boolean {
  const code = propertyOf(error, 'code');
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

function propertyOf(value: unknown, name: string): unknown {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? (value as Record<string, unknown>)[name]
    : undefined;
}
