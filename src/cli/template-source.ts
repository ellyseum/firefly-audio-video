/**
 * `describe()` takes a template strictly as a URL, with no upload path of
 * its own. {@link resolveTemplateUrl} is what lets `dgr describe` also take
 * a local file, matching `render`'s `--template <url|path>`: an http(s) URL
 * passes straight through, an existing local path is staged through the
 * client first, and anything else is passed through unchanged so
 * `describe()`'s own validation reports it.
 */

import { existsSync } from 'node:fs';
import type { Client } from '../dgr/client.js';

/** True for a string that parses as an `http:`/`https:` URL. */
function isHttpUrl(text: string): boolean {
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * A URL `describe()` can read `source` from: `source` itself when it is an
 * http(s) URL, else the presigned read URL `client.stage()` returns when
 * `source` names an existing local file, else `source` unchanged.
 *
 * @throws {@link AudioVideoError} whatever `client.stage()` throws — e.g.
 *   `invalid_argument` when the client has no storage configured.
 */
export async function resolveTemplateUrl(client: Client, source: string): Promise<string> {
  if (isHttpUrl(source) || !existsSync(source)) return source;
  return client.stage(source);
}
