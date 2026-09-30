/**
 * Advice in an SDK error, restated in the CLI's own terms before it prints.
 * The SDK tells its caller to pass a StorageProvider to configure() or
 * createClient(), or to pass a peer's module as a provider option — nothing
 * a CLI user can do. The CLI's flag and environment variable, or an install
 * command, take their place.
 */

import type { AudioVideoError } from '../core/errors.js';

/** The clause every SDK error about missing storage advises with. */
const SDK_STORAGE_ADVICE =
  'pass a StorageProvider as the storage option of configure() or createClient()';

/** The same advice for the CLI. */
const CLI_STORAGE_ADVICE =
  "pass --storage <uri> or set DGR_STORAGE ('s3://<bucket>[/<prefix>]', " +
  "'azure://<container>[/<prefix>]' or 'aio-files')";

/** The sentence a missing-peer error ends with: advice for bundled code, which passes the module itself. */
const BUNDLED_CODE_ADVICE =
  / In bundled code, where it cannot be loaded at run time, pass the module as the \w+ option instead\./;

/** The package a peer that failed to load was: `Loading <package> for <provider> failed (…)`. */
const LOAD_FAILURE = /^Loading (\S+) for \w+ failed \(/;

/** The advice a peer that failed to load ends with, after its loader's error: pass the module itself. */
const PASS_MODULE_ADVICE =
  /\. Pass the module as the \w+ option instead: a module passed in needs no run-time import\.$/;

/**
 * `error`'s message with its advice restated for the CLI: missing storage
 * names `--storage`/`DGR_STORAGE` and the URI forms they take, a missing
 * peer dependency names only the command that installs it, and a peer that
 * is installed but fails to load keeps its loader's error and names the
 * command that reinstalls it. Any other message comes back unchanged.
 */
export function cliMessage(error: AudioVideoError): string {
  if (error.code === 'missing_peer_dependency') {
    return error.message.replace(BUNDLED_CODE_ADVICE, '');
  }
  const failedToLoad = LOAD_FAILURE.exec(error.message)?.[1];
  if (error.code === 'storage_failed' && failedToLoad !== undefined) {
    return error.message.replace(
      PASS_MODULE_ADVICE,
      () => `: reinstall it with \`npm install ${failedToLoad}\`.`,
    );
  }
  return error.message.replaceAll(SDK_STORAGE_ADVICE, CLI_STORAGE_ADVICE);
}
