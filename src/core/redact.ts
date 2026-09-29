/**
 * The single mandatory redaction path used everywhere a value crosses from this SDK
 * out to a log record, a thrown error, or `console.log` — never log or throw an
 * unredacted secret. Four shapes are covered:
 *
 * - {@link redactUrl} — a URL's credentials: its user info (`user:pass@`) and
 *   every query parameter that carries or scopes a signature or a secret (Azure
 *   SAS, AWS SigV4 and SigV2, Google Cloud Storage V4 and V2, and any token,
 *   secret, password, credential or API-key parameter).
 * - {@link redactHeaders} — an HTTP header set's auth-bearing header values.
 * - {@link redactValue} — an arbitrary log record, error `.items`, or error
 *   `.message` string: walks objects/arrays recursively, scrubbing secret-named
 *   keys, any embedded URL, a secret parameter written in plain text (in its
 *   `&amp;` and percent-encoded forms too), a `Bearer` credential and a JWT.
 * - {@link redactError} — a redacted copy of an error, to keep as another
 *   error's `cause`.
 *
 * None of these throw, on any input, including a malformed URL or a circular
 * object graph — a redaction pass failing would be strictly worse than an
 * unredacted value, because it would abort the very log line or error meant to
 * report the failure.
 */

/**
 * The query-parameter names that carry or scope a credential, as a regex
 * source for one whole name, matched case-insensitively:
 *
 * - Azure SAS: `sig` and every parameter scoping it (`se`, `sp`, `sv`, …) —
 *   stripping only `sig` would still leave the rest narrowing what the leaked
 *   signature was valid for, so the whole set is treated as sensitive together;
 * - AWS: every SigV4 `x-amz-*` parameter, and SigV2's `AWSAccessKeyId`;
 * - Google Cloud Storage: every V4 `x-goog-*` parameter, and V2's `GoogleAccessId`;
 * - the bare `key` of a keyed API URL, and any name containing `signature`,
 *   `token`, `secret`, `password` or `passwd`, `credential`, `api_key`,
 *   `api-key` or `apikey`, or `private_key`.
 *
 * `free` is the character class the open-ended parts of a name may use.
 */
function secretParamNames(free: string): string {
  const sas =
    'sig|se|sp|sv|sr|st|spr|sip|si|srt|ss|skoid|sktid|skt|ske|sks|skv|saoid|suoid|scid|skdutid|sduoid|sdd|ses';
  const named = 'signature|token|secret|passw(?:or)?d|credential|api[-_]?key|private[-_]?key';
  return `${sas}|key|awsaccesskeyid|googleaccessid|x-amz-${free}*|x-goog-${free}*|${free}*(?:${named})${free}*`;
}

/** {@link secretParamNames} anchored to a whole parsed parameter name, case-insensitively. */
const SECRET_PARAM_RE = new RegExp(`^(?:${secretParamNames('.')})$`, 'is');

/** True for a parameter name {@link secretParamNames} matches. */
function isSecretQueryParam(key: string): boolean {
  return SECRET_PARAM_RE.test(key);
}

/**
 * Removes every {@link isSecretQueryParam} match from `url`'s query string —
 * each parameter entirely (name and value), not just its value, so that no
 * parameter name recognizable as a signing parameter (e.g. `sig=`) survives —
 * and returns the re-serialized URL, or `undefined` when there was nothing to
 * remove, so the caller can keep its original text. A query string whose
 * separators are HTML-escaped (`&amp;`) is left to the text pass, which reads
 * `&amp;` as a separator where the URL parser would fold it into the next
 * parameter's name.
 */
function stripSecrets(url: URL): string | undefined {
  const secret = url.search.includes('&amp;')
    ? []
    : [...new Set(url.searchParams.keys())].filter(isSecretQueryParam);
  if (secret.length === 0) return undefined;
  for (const key of secret) url.searchParams.delete(key);
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
  return u.includes('?') && !stripped.includes('?') ? stripped.replace('&', '?') : stripped;
}

/** `u` with its secret query parameters removed through the URL parser, or the raw fallback. */
function stripParsedSecrets(u: string): string {
  try {
    return stripSecrets(new URL(u)) ?? u;
  } catch {
    // Not an absolute URL (no scheme/host) — fall through to relative resolution.
  }
  try {
    const base = 'http://redact.invalid';
    const resolved = stripSecrets(new URL(u, base));
    if (resolved === undefined) return u;
    return resolved.startsWith(base) ? resolved.slice(base.length) : resolved;
  } catch {
    // Not parseable even as a relative reference — fall through to the raw scrub.
  }
  return stripSecretParamsFromRawString(u);
}

/**
 * Redacts a URL's credentials: its user info (`user:pass@`), and every query
 * parameter {@link secretParamNames} names — removing each matched parameter,
 * name and value, entirely rather than blanking its value in place — including
 * one separated by `;` or `&amp;`, or percent-encoded inside another
 * parameter's value. Every other part of the URL (origin, path, and
 * non-matching params) is preserved.
 *
 * Never throws: an absolute URL is redacted directly against the native `URL`
 * parser; a relative reference (no scheme/host) is resolved against a throwaway
 * base first so the same parameter-level logic still applies; anything neither of
 * those can parse falls back to a textual scrub. A URL with nothing to redact is
 * returned exactly as given. One that loses a parameter is re-serialized through
 * `URL`, which can normalize incidental details (scheme/host casing, a default
 * port, the encoding of the parameters that remain) without changing its meaning.
 *
 * @param u - A URL, absolute or relative, with or without a query string.
 * @returns `u` with its user info and every credential-bearing parameter removed.
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
  return stripSecretsFromText(stripParsedSecrets(u));
}

/**
 * Object keys and header names whose value is never kept, matched
 * case-insensitively anywhere in the name — plus the exact name `sig`.
 */
const SECRET_KEY_RE =
  /authorization|bearer|cookie|token|secret|passw(?:or)?d|credential|api[-_]?key|private[-_]?key|signature|^sig$/i;

/**
 * Redacts an HTTP header set by name: any header whose name matches the same
 * secret pattern object keys are checked against (`authorization`, `cookie`,
 * `x-api-key`, anything naming a token, secret, password, credential,
 * signature or private key — case-insensitive, so a capitalized `Authorization`
 * is redacted the same as lowercase) becomes the literal string `'REDACTED'`;
 * every other header passes through unchanged. Returns a new object — `headers`
 * is never mutated, since a caller may still need the original values for the
 * live request this redaction is only describing.
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
    out[key] = SECRET_KEY_RE.test(key) ? 'REDACTED' : value;
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
 * User info after any `//` — `https://user:pass@host`, `postgres://admin:pass@db`,
 * a protocol-relative `//user@host` — up to the last `@` before the host, so a
 * password that itself holds an `@` goes with it.
 */
const USERINFO_RE = /(\/\/)[^\s/?#"'<>]*@/g;

/**
 * Every {@link secretParamNames} parameter written as `name=value` in free text,
 * whether or not a URL run around it was recognized: a bare query string, a
 * form body, a URL whose path holds a raw space (`…/render (1).mov?sv=…&sig=…`)
 * and so ends before its query string, an HTML body's `&amp;sig=…`, or a URL
 * percent-encoded inside another (`%3Fsig%3D…`). The name follows the start of
 * the string, whitespace, `?`, `&`, `;`, `&amp;`, or their encodings `%3F`,
 * `%26`, `%3B`; an encoded value ends at the next encoded separator.
 */
const TEXT_SECRET_PARAM_RE = new RegExp(
  `(^|&amp;|%26|%3F|%3B|[\\s?&;])(?:${secretParamNames('[\\w.-]')})` +
    `(?:=[^&;#\\s"'<>]*|%3D(?:(?!%26|%3B|%23)[^&;#\\s"'<>])*)`,
  'gi',
);

/** The separators a removed {@link TEXT_SECRET_PARAM_RE} match takes with it: every one but a query start. */
const PARAM_SEPARATOR_RE = /^(?:&|;|&amp;|%26|%3B)$/i;

/**
 * Removes every {@link TEXT_SECRET_PARAM_RE} match, name and value, with the
 * `&`, `;`, `&amp;` or encoded separator before it; a `?` (or `%3F`),
 * whitespace or the start of the string stays.
 */
function stripSecretParamsFromText(s: string): string {
  return s.replace(TEXT_SECRET_PARAM_RE, (_match: string, before: string) =>
    PARAM_SEPARATOR_RE.test(before) ? '' : before,
  );
}

/** The text-level passes a URL, or any string, gets: user info after `//`, then every secret parameter. */
function stripSecretsFromText(s: string): string {
  return stripSecretParamsFromText(s.replace(USERINFO_RE, '$1'));
}

/**
 * A `Bearer` credential written in free text — `Authorization: Bearer eyJ…` —
 * with the scheme matched case-insensitively. A word of lowercase letters
 * alone after it, as in "a bearer token", is prose and stays.
 */
const BEARER_RE = /\b([Bb][Ee][Aa][Rr][Ee][Rr]\s+)(?![a-z]+(?![\w\-.~+/=]))[\w\-.~+/]+=*/g;

/** A JWT: three base64url segments, the first opening with `eyJ` (the encoding of `{"`). */
const JWT_RE = /\beyJ[\w-]+\.[\w-]+\.[\w-]*/g;

/** Every redaction a free-text string gets: embedded URLs, user info, secret parameters, `Bearer` credentials and JWTs. */
function redactString(s: string): string {
  return stripSecretsFromText(redactEmbeddedUrls(s))
    .replace(BEARER_RE, '$1REDACTED')
    .replace(JWT_RE, 'REDACTED');
}

/** What an object, array or property that cannot be read — a throwing getter or Proxy trap, a revoked Proxy — becomes. */
const UNREADABLE = '[Unreadable]';

function redactValueInner(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  try {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => redactValueInner(item, seen));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[redactString(key)] = SECRET_KEY_RE.test(key)
        ? 'REDACTED'
        : redactValueInner(readProperty(value, key), seen);
    }
    return out;
  } catch {
    return UNREADABLE;
  }
}

/** `value[key]`, or {@link UNREADABLE} when reading it throws — one bad getter never costs its siblings. */
function readProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return UNREADABLE;
  }
}

/**
 * Deep-walks `value`, redacting as it goes. A string has every embedded URL run
 * through {@link redactUrl}, then loses any user info or secret parameter
 * still written in its text (`sig=…` in a bare query string, an HTML body's
 * `&amp;sig=…`, a percent-encoded `%3Fsig%3D…`), any `Bearer` credential
 * (`Bearer REDACTED`) and any JWT (`REDACTED`). An array is walked element by
 * element. An object has each key checked against a known secret pattern
 * (`authorization`, `cookie`, `sig`, and anything naming a token, secret,
 * password, credential, API key, private key, signature or bearer —
 * case-insensitive) — a match replaces the whole value with `'REDACTED'`
 * without recursing into it, anything else recurses — and each key is itself
 * redacted as a string, so a URL used as a key loses its signature too. Every
 * other value (numbers, booleans, `null`, `undefined`) passes through
 * unchanged. A value already visited earlier on the same walk (a circular
 * reference) is reported as the literal string `'[Circular]'` rather than
 * recursed into again, and one that cannot be read — a throwing getter or
 * Proxy trap, a revoked Proxy — as `'[Unreadable]'`.
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

/** How many levels of an error's `cause` chain {@link redactError} copies. */
const MAX_CAUSE_DEPTH = 4;

/**
 * A redacted stand-in for an error about to become another error's
 * `cause`: a new `Error` carrying the original's `name`, its `code` (a string
 * or number), its message run through {@link redactValue}, and — to a depth
 * of four — its own `cause` copied the same way. The original is never kept:
 * a transport error can still hold an unredacted URL in its message or its
 * cause. A value that is not an `Error` becomes one from its string form.
 * Never throws.
 *
 * @param error - Whatever was thrown or rejected.
 * @returns A new `Error` safe to keep as a `cause`.
 *
 * @internal
 */
export function redactError(error: unknown): Error {
  return redactErrorAt(error, 1);
}

function redactErrorAt(error: unknown, depth: number): Error {
  let copy: Error;
  try {
    if (!(error instanceof Error)) return new Error(redactValue(String(error)));
    copy = new Error(redactValue(String(error.message)));
    copy.name = String(error.name);
    const { code, cause } = error as Error & { code?: unknown };
    if (typeof code === 'string' || typeof code === 'number') {
      (copy as Error & { code?: string | number }).code = code;
    }
    if (cause !== undefined && depth < MAX_CAUSE_DEPTH)
      copy.cause = redactErrorAt(cause, depth + 1);
  } catch {
    return new Error('[Unreadable error]');
  }
  return copy;
}
