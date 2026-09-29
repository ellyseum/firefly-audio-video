/**
 * The single mandatory redaction path used everywhere a value crosses from this SDK
 * out to a log record, a thrown error, or `console.log` — never log or throw an
 * unredacted secret. Three shapes are covered:
 *
 * - {@link redactUrl} — a presigned URL's Azure SAS or AWS SigV4 query parameters.
 * - {@link redactHeaders} — an HTTP header set's auth-bearing header values.
 * - {@link redactValue} — an arbitrary log record, error `.items`, or error
 *   `.message` string: walks objects/arrays recursively, scrubbing both
 *   secret-named keys and any embedded URL.
 *
 * None of these throw, on any input, including a malformed URL or a circular
 * object graph — a redaction pass failing would be strictly worse than an
 * unredacted value, because it would abort the very log line or error meant to
 * report the failure.
 */

/**
 * The query-parameter names that carry or scope a presigned URL's signature,
 * as a regex source for one whole name: the Azure SAS names — stripping only
 * `sig` would still leave `se`/`sp`/etc. narrowing what the leaked signature
 * was valid for, so the whole set is treated as sensitive together — every
 * AWS `x-amz-*` parameter, and anything naming a signature. `free` is the
 * character class the open-ended parts of a name may use.
 */
function secretParamNames(free: string): string {
  return `sig|se|sp|sv|sr|st|skoid|sktid|skt|ske|sks|skv|x-amz-${free}*|${free}*signature${free}*`;
}

/** {@link secretParamNames} anchored to a whole parsed parameter name, case-insensitively. */
const SECRET_PARAM_RE = new RegExp(`^(?:${secretParamNames('.')})$`, 'is');

/** True for an Azure SAS param name, an AWS `x-amz-*` param, or anything naming a signature. */
function isSecretQueryParam(key: string): boolean {
  return SECRET_PARAM_RE.test(key);
}

/**
 * Deletes every {@link isSecretQueryParam} match from `url`'s query string —
 * removing the parameter entirely (name and value), not just blanking its value,
 * so that no parameter name recognizable as a signing parameter (e.g. `sig=`)
 * survives in the result.
 */
function stripSecretSearchParams(url: URL): string {
  for (const key of new Set(url.searchParams.keys())) {
    if (isSecretQueryParam(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

/**
 * The same param names {@link isSecretQueryParam} matches, as a pattern that also
 * consumes the leading separator (`?`/`&`/`;`) so the removed segment leaves no
 * `key=` fragment behind. Used only by {@link stripSecretParamsFromRawString}, the
 * last-resort path for a string {@link redactUrl} cannot parse as a URL at all.
 */
const RAW_SECRET_PARAM_RE = new RegExp(
  `([?&;])(?:${secretParamNames('[a-z0-9_-]')})=[^&;#\\s]*`,
  'gi',
);

/**
 * Textual fallback for a string that is not parseable as a URL, even as a relative
 * reference: deletes matched `separator + key=value` runs directly. If deleting a
 * leading run consumed the string's only `?`, the first surviving `&` is promoted
 * to `?` so the remaining params still read as a valid query string.
 */
function stripSecretParamsFromRawString(u: string): string {
  const stripped = u.replace(RAW_SECRET_PARAM_RE, '');
  return !stripped.includes('?') && stripped.includes('&') ? stripped.replace('&', '?') : stripped;
}

/**
 * Redacts a presigned URL's Azure SAS or AWS SigV4 query parameters, removing each
 * matched parameter — name and value — entirely, rather than blanking its value in
 * place. Every other part of the URL (origin, path, and non-matching params) is
 * preserved.
 *
 * Never throws: an absolute URL is redacted directly against the native `URL`
 * parser; a relative reference (no scheme/host) is resolved against a throwaway
 * base first so the same parameter-level logic still applies; anything neither of
 * those can parse falls back to a textual scrub. A URL that parses but has nothing
 * to redact is still re-serialized through `URL`, which can normalize incidental
 * details (scheme/host casing, a default port) without changing its meaning.
 *
 * @param u - A URL, absolute or relative, with or without a query string.
 * @returns `u` with every SAS/AWS signing parameter removed.
 *
 * @example
 * ```ts
 * redactUrl('https://x.blob.core.windows.net/f?sv=2021&sig=SECRET&se=2026&rest=keep');
 * // -> 'https://x.blob.core.windows.net/f?rest=keep'
 * ```
 *
 * @internal
 */
export function redactUrl(u: string): string {
  try {
    return stripSecretSearchParams(new URL(u));
  } catch {
    // Not an absolute URL (no scheme/host) — fall through to relative resolution.
  }
  try {
    const base = 'http://redact.invalid';
    const resolved = stripSecretSearchParams(new URL(u, base));
    return resolved.startsWith(base) ? resolved.slice(base.length) : resolved;
  } catch {
    // Not parseable even as a relative reference — fall through to the raw scrub.
  }
  return stripSecretParamsFromRawString(u);
}

/** Header names whose value must never be logged or thrown, matched case-insensitively. */
const HEADER_SECRET_KEY_RE = /authorization|x-api-key|api-key|cookie|token|secret/i;

/**
 * Redacts an HTTP header set by name: any header matching a known secret pattern
 * (`authorization`, `x-api-key`, `api-key`, `cookie`, `token`, `secret` —
 * case-insensitive, so a capitalized `Authorization` is redacted the same as
 * lowercase) becomes the literal string `'REDACTED'`; every other header passes
 * through unchanged. Returns a new object — `headers` is never mutated, since a
 * caller may still need the original values for the live request this redaction
 * is only describing.
 *
 * @param headers - The header set to redact, as sent or received.
 * @returns A new header set with secret values replaced.
 *
 * @example
 * ```ts
 * redactHeaders({ Authorization: 'Bearer T', 'content-type': 'application/json' });
 * // -> { Authorization: 'REDACTED', 'content-type': 'application/json' }
 * ```
 *
 * @internal
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = HEADER_SECRET_KEY_RE.test(key) ? 'REDACTED' : value;
  }
  return out;
}

/**
 * An `http(s)://` run anywhere within a larger string. It ends at whitespace, a
 * double quote, a backtick, `<`, `>`, a bracket, a brace or a comma, and runs
 * on through `(`, `)` and `'` — characters `encodeURIComponent` leaves
 * unescaped, so a key built from a file name such as `render (1).mov` keeps
 * them, and stopping there would cut the query string off the URL.
 */
const EMBEDDED_URL_RE = /https?:\/\/[^\s"`<>[\]{},]+/gi;

/** Characters that end a sentence rather than a URL when they close a run. */
const SENTENCE_END = new Set(['.', ';', ':', '!', '?']);

/**
 * How much of a URL run is the URL. Trailing sentence punctuation, a `)` the
 * run holds more of than `(`, and a closing `'` when a `'` stands just before
 * the run all belong to the prose around it: `(see https://x/f?sig=S).` keeps
 * its `).` while the URL inside is redacted.
 */
function urlLength(run: string, quoted: boolean): number {
  let unclosed = 0;
  for (const ch of run) {
    if (ch === '(') unclosed -= 1;
    else if (ch === ')') unclosed += 1;
  }
  let end = run.length;
  let quote = quoted;
  while (end > 0) {
    const last = run.charAt(end - 1);
    if (SENTENCE_END.has(last)) {
      end -= 1;
    } else if (last === ')' && unclosed > 0) {
      unclosed -= 1;
      end -= 1;
    } else if (last === "'" && quote) {
      quote = false;
      end -= 1;
    } else {
      break;
    }
  }
  return end;
}

/**
 * Runs every embedded URL found in `s` through {@link redactUrl} — `s` need not be
 * a bare URL itself; an error message that merely mentions one is a common shape.
 */
function redactEmbeddedUrls(s: string): string {
  return s.replace(EMBEDDED_URL_RE, (run: string, offset: number) => {
    const end = urlLength(run, s.charAt(offset - 1) === "'");
    return redactUrl(run.slice(0, end)) + run.slice(end);
  });
}

/**
 * Every {@link secretParamNames} parameter written as `name=value` in free text
 * — after `?`, `&`, `;` or whitespace, or at the very start — whether or not a
 * URL run around it was recognized: a bare query string, or a URL whose path
 * holds a raw space (`…/render (1).mov?sv=…&sig=…`), where the run ends at the
 * space, before the query string.
 */
const TEXT_SECRET_PARAM_RE = new RegExp(
  `(^|[\\s?&;])(?:${secretParamNames('[\\w.-]')})=[^&;#\\s"'<>]*`,
  'gi',
);

/**
 * Removes every {@link TEXT_SECRET_PARAM_RE} match, name and value, with the
 * `&` or `;` before it; a `?`, whitespace or the start of the string stays.
 */
function stripSecretParamsFromText(s: string): string {
  return s.replace(TEXT_SECRET_PARAM_RE, (_match: string, before: string) =>
    before === '&' || before === ';' ? '' : before,
  );
}

/** Every redaction a free-text string gets: its embedded URLs, then any signing parameter left in the text. */
function redactString(s: string): string {
  return stripSecretParamsFromText(redactEmbeddedUrls(s));
}

/** Object/array key names whose value must never be logged or thrown, matched case-insensitively. */
const VALUE_SECRET_KEY_RE = /authorization|api-key|token|secret|bearer/i;

function redactValueInner(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((item) => redactValueInner(item, seen));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = VALUE_SECRET_KEY_RE.test(key) ? 'REDACTED' : redactValueInner(val, seen);
    }
    return out;
  }
  return value;
}

/**
 * Deep-walks `value`, redacting as it goes: a string has every embedded URL run
 * through {@link redactUrl}, then any signing parameter still written in its
 * text (`sig=…` in a bare query string, or after a URL whose path held a raw
 * space) removed; an array is walked element by element; an object has
 * each key checked against a known secret pattern (`authorization`, `api-key`,
 * `token`, `secret`, `bearer` — case-insensitive) — a match replaces the whole
 * value with `'REDACTED'` without recursing into it, anything else recurses; every
 * other value (numbers, booleans, `null`, `undefined`) passes through unchanged. A
 * value already visited earlier on the same walk (a circular reference) is
 * reported as the literal string `'[Circular]'` rather than recursed into again.
 *
 * This is the SDK's general-purpose redaction path for anything that is not
 * already known to be a bare URL or a header set — {@link redactUrl} and
 * {@link redactHeaders} are cheaper and more precise when the shape is already
 * known. `AudioVideoError`'s `.message` and `.items` (./errors.ts) both route
 * through this function. Never throws.
 *
 * @param value - Anything: a log record, an error's `.items`, an error's
 *   `.message`, or a single primitive.
 * @returns A structurally equivalent value with every secret redacted.
 *
 * @example
 * ```ts
 * redactValue({ statusUrl: 'https://x/s?sig=SECRET', n: 1 });
 * // -> { statusUrl: 'https://x/s', n: 1 }
 * ```
 *
 * @internal
 */
export function redactValue(value: string): string;
/** @internal */
export function redactValue(value: unknown[]): unknown[];
/** @internal */
export function redactValue(value: unknown): unknown;
export function redactValue(value: unknown): unknown {
  return redactValueInner(value, new WeakSet());
}
