/** Small error constructors the CLI's own validation raises, ahead of any SDK call. */

import { AudioVideoError } from '../core/errors.js';

/** An {@link AudioVideoError} with `code: 'invalid_argument'` — the CLI's usage-error code. */
export function invalidArgument(message: string, cause?: unknown): AudioVideoError {
  return new AudioVideoError({ message, code: 'invalid_argument', cause });
}
