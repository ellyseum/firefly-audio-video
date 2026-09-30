/**
 * Property-based coverage for the redaction module (`src/core/redact.ts`), generalizing
 * `test/redact.test.ts`'s and `test/storage-held-secrets.test.ts`'s fixed examples to
 * arbitrary secrets, URLs and text: a held secret survives in no spelling its scrub
 * covers, a presigned URL's secret query parameters survive in no text they are embedded
 * in, redaction reaches a fixed point in one pass, and text with none of the recognized
 * secret shapes comes back unchanged (so the suite also proves the redactor does not
 * over-redact).
 *
 * `numRuns: 300` per property: each run does a handful of string operations, so 1200
 * total iterations run in a small fraction of a second — thorough without adding
 * meaningfully to the suite's wall time. Failures are reported with fast-check's default
 * reporter, which prints the seed and the shrunk counterexample needed to reproduce one.
 */

import { inspect } from 'node:util';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { redactValue } from '../src/core/redact.js';
import { adapterError } from '../src/storage/shared.js';

// --- shared building blocks --------------------------------------------------

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split('');

/** An alnum-only string, for values that must survive every encoder unescaped. */
function alnumArb(minLength: number, maxLength: number): fc.Arbitrary<string> {
  return fc.string({ unit: fc.constantFrom(...ALNUM), minLength, maxLength });
}

// --- property 1: a held secret never survives redactValue or the scrub entry point ------

/** Every character a held secret is drawn from: base64/base64url plus its padding character. */
const SECRET_ALPHABET = [...ALNUM, '+', '/', '='];

/** A secret long enough for its spellings to differ meaningfully from one another. */
const secretArb = fc.string({
  unit: fc.constantFrom(...SECRET_ALPHABET),
  minLength: 8,
  maxLength: 32,
});

/** `text` with the hex digits of every percent-escape lowercased. */
function lowerHex(text: string): string {
  return text.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
}

/** `secret` without its trailing `=` padding. */
function unpadded(secret: string): string {
  return secret.replace(/=+$/, '');
}

/**
 * The spellings a third party's error text can give a held secret — generalizing
 * `test/storage-held-secrets.test.ts`'s `SPELLINGS` (fixed example secrets) to an
 * arbitrary one.
 */
const SPELLINGS: ReadonlyArray<readonly [name: string, spell: (secret: string) => string]> = [
  ['raw', (secret) => `refused ${secret} as given`],
  ['percent-encoded', (secret) => `next=${encodeURIComponent(secret)}`],
  ['percent-encoded in lowercase hex', (secret) => `next=${lowerHex(encodeURIComponent(secret))}`],
  ['percent-encoded twice', (secret) => `next=${encodeURIComponent(encodeURIComponent(secret))}`],
  ['with only its + encoded', (secret) => `refused ${secret.replaceAll('+', '%2B')}`],
  ['form-decoded, a + read as a space', (secret) => `refused "${secret.replaceAll('+', ' ')}"`],
  [
    'in base64url',
    (secret) => `refused ${unpadded(secret).replaceAll('+', '-').replaceAll('/', '_')}`,
  ],
  ['without its padding', (secret) => `refused ${unpadded(secret)}.`],
];

const spellingArb = fc.constantFrom(...SPELLINGS);

/**
 * A three-level failure quoting `text` on every level a caller-supplied scrub covers: an
 * outer message and name, a middle message and code, and an inner string cause — the same
 * shape `test/storage-held-secrets.test.ts`'s `failure()` helper builds.
 */
function failure(text: string): Error {
  return Object.assign(new Error(`outer ${text}`), {
    name: `RestError ${text}`,
    cause: Object.assign(new Error(`middle ${text}`), {
      code: `E ${text}`,
      cause: `inner ${text}`,
    }),
  });
}

test('property: a held secret, in every spelling its scrub covers, never survives on any level', () => {
  fc.assert(
    fc.property(secretArb, spellingArb, (secret, [spelling, spell]) => {
      // A secret of nothing but padding has no non-padding "body": heldSecretPattern then
      // requires every `=` verbatim rather than allowing padding to be dropped, so the
      // padding-stripping spellings below would embed no spelling of it at all.
      fc.pre(!/^=+$/.test(secret));

      const embedded = spell(secret);
      const error = adapterError('Signing failed', failure(embedded), [secret]);
      const outerCause = error.cause as Error;
      const middleCause = outerCause.cause as Error & { code?: unknown };
      const innermostCause = middleCause.cause as Error;
      const everywhere = [
        error.message,
        outerCause.message,
        outerCause.name,
        middleCause.message,
        String(middleCause.code),
        innermostCause.message,
        String(error),
        JSON.stringify(error),
        inspect(error, { depth: null }),
      ].join('\n');

      expect(everywhere, spelling).not.toContain(embedded);
      // The check must be capable of seeing what it guards: unredacted context survives.
      expect(everywhere, spelling).toContain('outer ');
      expect(everywhere, spelling).toContain('middle ');
      expect(everywhere, spelling).toContain('inner ');
    }),
    { numRuns: 300 },
  );
});

// --- property 2: presigned-URL secrets never survive embedded in arbitrary text ---------

/** Representative secret-bearing parameter names, across the SAS, AWS, GCS and generic-named families. */
const SECRET_PARAM_NAMES = [
  'sig',
  'se',
  'sp',
  'sv',
  'sr',
  'st',
  'spr',
  'sip',
  'si',
  'srt',
  'ss',
  'skoid',
  'sktid',
  'skt',
  'ske',
  'sks',
  'skv',
  'saoid',
  'suoid',
  'scid',
  'skdutid',
  'sduoid',
  'sdd',
  'ses',
  'key',
  'AWSAccessKeyId',
  'GoogleAccessId',
  'X-Amz-Signature',
  'X-Amz-Credential',
  'X-Amz-Security-Token',
  'X-Goog-Signature',
  'X-Goog-Credential',
  'token',
  'secret',
  'password',
  'passwd',
  'credential',
  'api_key',
  'api-key',
  'apikey',
  'private_key',
] as const;

/** Parameter names that never carry a secret: none contains a {@link SECRET_PARAM_NAMES} substring. */
const KEEP_PARAM_NAMES = [
  'rest',
  'foo',
  'bar',
  'market',
  'width',
  'height',
  'format',
  'debug',
  'lang',
  'color',
] as const;

const secretParamNameArb = fc
  .constantFrom(...SECRET_PARAM_NAMES)
  .chain((name) => fc.constantFrom(name, name.toUpperCase(), name.toLowerCase()));

const hostArb = fc.constantFrom(
  'x.blob.core.windows.net',
  's3.amazonaws.com',
  'storage.googleapis.com',
  'cdn.example.org',
);

test('property: a presigned URL’s secret query parameters never survive embedded in arbitrary text', () => {
  fc.assert(
    fc.property(
      fc.string(),
      fc.string(),
      hostArb,
      alnumArb(0, 10),
      secretParamNameArb,
      alnumArb(6, 24),
      fc.constantFrom(...KEEP_PARAM_NAMES),
      alnumArb(1, 12),
      fc.boolean(),
      (prefix, suffix, host, path, secretName, secretValue, keepName, keepValue, secretFirst) => {
        const secretParam = `${encodeURIComponent(secretName)}=${secretValue}`;
        const keepParam = `${keepName}=${keepValue}`;
        const query = secretFirst ? `${secretParam}&${keepParam}` : `${keepParam}&${secretParam}`;
        const url = `https://${host}/${path}?${query}`;
        const text = `${prefix} ${url} ${suffix}`;

        const out = redactValue(text);

        expect(out, url).not.toContain(secretValue);
        expect(out, url).toContain(keepParam);
      },
    ),
    { numRuns: 300 },
  );
});

// --- property 3: redaction reaches a fixed point in one pass -----------------------------

/** A string built from the same secret-URL and held-secret shapes the other properties use, so idempotence is exercised on input that actually has something to redact, not only on text with nothing to remove. */
const redactableStringArb = fc.oneof(
  fc.string(),
  fc.tuple(secretArb, spellingArb).map(([secret, [, spell]]) => `case ${spell(secret)} failed`),
  fc
    .tuple(hostArb, alnumArb(0, 8), secretParamNameArb, alnumArb(6, 16))
    .map(
      ([host, path, name, value]) =>
        `see https://${host}/${path}?${name}=${value}&rest=keep for detail`,
    ),
  fc.constant('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SIG mid-request'),
  fc.constant(
    'DefaultEndpointsProtocol=https;AccountName=x;AccountKey=SECRETKEY==;EndpointSuffix=core.windows.net',
  ),
);

const jsonLikeArb: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    { maxDepth: 3 },
    redactableStringArb,
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.string({ maxLength: 16 }), tie('value'), { maxKeys: 4 }),
  ),
})).value;

test('property: redacting an already-redacted value changes nothing further', () => {
  fc.assert(
    fc.property(jsonLikeArb, (value) => {
      const once = redactValue(value);
      const twice = redactValue(once);
      expect(twice).toEqual(once);
    }),
    { numRuns: 300 },
  );
});

// --- property 4: text with none of the recognized secret shapes is untouched ------------

/**
 * Characters that cannot, on their own, form a URL scheme, a query-string separator, a
 * JWT's two literal dots, or a connection-string `name=value` setting — so text built only
 * from these (and, belt-and-suspenders, filtered of the literal words "bearer" and "eyj")
 * is provably outside every shape {@link redactValue} recognizes.
 */
const SAFE_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ,!\'"()_-~'.split('');

const safeTextArb = fc
  .string({ unit: fc.constantFrom(...SAFE_CHARS), maxLength: 200 })
  .filter((s) => !/bearer|eyj/i.test(s));

test('property: text with none of the recognized secret shapes comes back unchanged', () => {
  fc.assert(
    fc.property(safeTextArb, (text) => {
      expect(redactValue(text)).toBe(text);
    }),
    { numRuns: 300 },
  );
});
