/**
 * The client a command runs on: the runtime's injected {@link Client} when
 * one was given (every command test uses this path — nothing here ever
 * builds a real client under test), else a real one built from
 * `--client-id`/`--client-secret`/`--scope` (or their `IMS_OAUTH_S2S_*`
 * environment names) and `--storage`/`--region` (or `DGR_STORAGE`).
 */

import { createClient, type Client } from '../dgr/client.js';
import { stdoutJsonLogger } from '../core/logging.js';
import { invalidArgument } from './errors.js';
import type { CliRuntime, GlobalOptions } from './runtime.js';
import { resolveStorage } from './storage.js';
import { firstNonEmpty } from './util.js';

/**
 * The client `options` names: `runtime.client` if the runtime was given one,
 * else a client built from `options` and `runtime.env`. `--log` routes the
 * SDK's own NDJSON call log to `runtime.stderr`; without it, SDK logging is
 * off, so stdout carries only the command's own result.
 *
 * @throws {@link AudioVideoError} `invalid_argument` when no client ID and
 *   secret are configured, or `--storage`/`DGR_STORAGE` names an invalid or
 *   unbuildable storage target.
 */
export function resolveClient(runtime: CliRuntime, options: GlobalOptions): Client {
  if (runtime.client !== undefined) return runtime.client;

  const clientId = firstNonEmpty(options.clientId, runtime.env.IMS_OAUTH_S2S_CLIENT_ID);
  const clientSecret = firstNonEmpty(options.clientSecret, runtime.env.IMS_OAUTH_S2S_CLIENT_SECRET);
  if (clientId === undefined || clientSecret === undefined) {
    throw invalidArgument(missingCredentialsMessage(clientId, clientSecret));
  }

  const scope = firstNonEmpty(options.scope, runtime.env.IMS_OAUTH_S2S_SCOPES);
  const storageUri = firstNonEmpty(options.storage, runtime.env.DGR_STORAGE);

  return createClient({
    clientId,
    clientSecret,
    ...(scope !== undefined ? { scope } : {}),
    ...(storageUri !== undefined
      ? { storage: resolveStorage(storageUri, runtime.env, options.region) }
      : {}),
    logging: options.log === true ? stdoutJsonLogger({ stream: runtime.stderr }) : false,
  });
}

/** Names both ways to configure whichever credential is missing; never echoes a value. */
function missingCredentialsMessage(
  clientId: string | undefined,
  clientSecret: string | undefined,
): string {
  const missing: string[] = [];
  if (clientId === undefined) missing.push('--client-id (or IMS_OAUTH_S2S_CLIENT_ID)');
  if (clientSecret === undefined) missing.push('--client-secret (or IMS_OAUTH_S2S_CLIENT_SECRET)');
  return (
    `No credentials configured: set ${missing.join(' and ')}. ` +
    'The environment is preferred over --client-secret — a value on the command line is visible ' +
    'to other processes on this machine.'
  );
}
