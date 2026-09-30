/** Small helpers shared across the CLI's option and environment resolution. */

/** The first value that is defined and non-blank once trimmed, or `undefined`. */
export function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value;
  }
  return undefined;
}
