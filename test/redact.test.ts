import { inspect } from 'node:util';
import { expect, test } from 'vitest';
import { redactError, redactUrl, redactHeaders, redactValue } from '../src/core/redact.js';
import { AudioVideoError } from '../src/core/errors.js';

// --- redactUrl ---------------------------------------------------------------

test('redactUrl: strips Azure SAS params, keeps other params', () => {
  const out = redactUrl('https://x.blob.core.windows.net/f?sv=2021&sig=SECRET&se=2026&rest=keep');
  expect(out).not.toContain('SECRET');
  expect(out).not.toContain('sig=');
  expect(out).toContain('rest=keep');
});

test('redactUrl: strips AWS SigV4 params', () => {
  const out = redactUrl(
    'https://s3.amazonaws.com/f?X-Amz-Signature=ABC&X-Amz-Credential=Z&rest=keep',
  );
  expect(out).not.toMatch(/ABC|Z/);
  expect(out).toContain('rest=keep');
});

test('redactUrl: a URL with no secret params is returned with its params intact', () => {
  const out = redactUrl('https://example.com/path?a=1&b=2');
  expect(out).toContain('a=1');
  expect(out).toContain('b=2');
});

test('redactUrl: a URL with nothing to redact comes back exactly as given', () => {
  for (const url of [
    'HTTPS://Example.COM:443/a%20b?name=a%20b&t=~x',
    'https://other-host.example',
    '/v1/presets?q=a%20b',
    // An `&` with no `?` stays an `&` when nothing was removed, parseable or not.
    '/v1/presets&debug=1',
    'http://[bad-host]/f&keep=1',
  ]) {
    expect(redactUrl(url)).toBe(url);
  }
  expect(redactValue('is on https://other-host.example, not https://api.example:')).toBe(
    'is on https://other-host.example, not https://api.example:',
  );
});

test('redactUrl: never throws on a malformed URL, and still redacts what it can', () => {
  const input = 'http://[bad-host]?sig=SECRET&rest=keep';
  let out = '';
  expect(() => {
    out = redactUrl(input);
  }).not.toThrow();
  expect(out).not.toContain('SECRET');
  // The removed leading parameter took the `?` with it; the next parameter takes its place.
  expect(out).toBe('http://[bad-host]?rest=keep');
});

test('redactUrl: never throws on a string with no URL structure at all', () => {
  expect(() => redactUrl('not a url in any sense')).not.toThrow();
});

test('redactUrl: a protocol-relative URL is resolved and still redacted', () => {
  const out = redactUrl('//attacker.example/path?sig=SECRET&rest=keep');
  expect(out).not.toContain('SECRET');
  expect(out).toContain('attacker.example');
  expect(out).toContain('rest=keep');
});

// --- redactHeaders -------------------------------------------------------------

test('redactHeaders: redacts by name, case-insensitively, and passes other headers through', () => {
  const headers = {
    authorization: 'Bearer T',
    'x-api-key': 'K',
    Cookie: 'session=abc',
    'content-type': 'application/json',
  };
  const out = redactHeaders(headers);
  expect(out.authorization).toBe('REDACTED');
  expect(out['x-api-key']).toBe('REDACTED');
  expect(out.Cookie).toBe('REDACTED');
  expect(out['content-type']).toBe('application/json');
});

test('redactHeaders: a capitalized Authorization header is still redacted', () => {
  const out = redactHeaders({ Authorization: 'Bearer T', 'Content-Type': 'application/json' });
  expect(out.Authorization).toBe('REDACTED');
  expect(out['Content-Type']).toBe('application/json');
});

test('redactHeaders: does not mutate its input', () => {
  const headers = { authorization: 'Bearer T' };
  redactHeaders(headers);
  expect(headers.authorization).toBe('Bearer T');
});

// --- redactValue -----------------------------------------------------------------

test('redactValue: deep-redacts a URL-with-SAS nested in an object, preserving non-secret fields', () => {
  const out = redactValue({
    statusUrl: 'https://x/s?sig=SECRET',
    n: 1,
    nested: { ok: true },
  }) as Record<string, unknown>;
  expect(JSON.stringify(out)).not.toContain('SECRET');
  expect(out.n).toBe(1);
  expect(out.nested).toEqual({ ok: true });
});

test('redactValue: redacts an object key matching a secret pattern without recursing into it', () => {
  const out = redactValue({ authorization: { nested: 'Bearer T' }, note: 'ok' }) as Record<
    string,
    unknown
  >;
  expect(out.authorization).toBe('REDACTED');
  expect(out.note).toBe('ok');
});

test('redactValue: redacts an embedded URL inside a larger prose string', () => {
  const out = redactValue(
    'Render failed for https://x.blob/f?sig=SECRET&se=2026 after 3 attempts.',
  );
  expect(out).not.toContain('SECRET');
  expect(out).toContain('Render failed for');
  expect(out).toContain('after 3 attempts.');
});

test('redactValue: a URL whose path holds ( ) or an apostrophe loses its signature', () => {
  const parens = redactValue(
    'https://a.blob.core.windows.net/c/render%20(1).mp4?sv=2021&se=2026&sig=PARENSIG',
  );
  expect(parens).toBe('https://a.blob.core.windows.net/c/render%20(1).mp4');

  const apostrophe = redactValue(
    "https://a.blob.core.windows.net/c/mom's%20clip.mp4?sv=2021&sig=APOSSIG&rest=keep",
  );
  expect(apostrophe).toBe("https://a.blob.core.windows.net/c/mom's%20clip.mp4?rest=keep");
});

test('redactValue: a ) or quote wrapping a URL, and sentence punctuation after it, stay in the prose', () => {
  expect(
    redactValue('Upload failed (see https://a.blob.core.windows.net/c/f.mp4?sig=WRAPSIG).'),
  ).toBe('Upload failed (see https://a.blob.core.windows.net/c/f.mp4).');
  expect(
    redactValue(
      "Could not read 'https://a.blob.core.windows.net/c/mom's.mp4?sig=QUOTESIG' in time",
    ),
  ).toBe("Could not read 'https://a.blob.core.windows.net/c/mom's.mp4' in time");
  // The URL's own `(1)` stays; only the `)` it never opened goes back to the prose.
  expect(redactValue('Saved (https://a.blob.core.windows.net/c/take(1)?sig=OWNPARENSIG)!')).toBe(
    'Saved (https://a.blob.core.windows.net/c/take(1))!',
  );
});

test('redactValue: a signing parameter left in the text after a URL run ends is still removed', () => {
  const cases: Array<[input: string, kept: string]> = [
    // A raw space in the path ends the URL run before its query string.
    [
      'Could not write https://acct.blob.core.windows.net/out/render (1).mov?sv=2021&sp=cw&sig=SPACESIG',
      'Could not write https://acct.blob.core.windows.net/out/render (1).mov?',
    ],
    // A bare query string, no URL at all: the first parameter sits at the start.
    ['sig=STARTSIG&keep=1', '&keep=1'],
    // After whitespace.
    ['signed with sig=SPACEDSIG today', 'signed with  today'],
    // `;`-separated, which a URL parser does not treat as a separator.
    ['/f?a=1;sig=SEMISIG', '/f?a=1'],
  ];
  for (const [input, kept] of cases) {
    const out = redactValue(input);
    expect(out, input).toBe(kept);
    expect(out, input).not.toMatch(/SIG\b/);
  }
});

test('redactValue: walks arrays element by element', () => {
  const out = redactValue(['https://x/f?sig=SECRET', { token: 'T', note: 'ok' }]);
  expect(JSON.stringify(out)).not.toContain('SECRET');
  expect((out[1] as Record<string, unknown>).token).toBe('REDACTED');
  expect((out[1] as Record<string, unknown>).note).toBe('ok');
});

test('redactValue: primitives pass through unchanged', () => {
  expect(redactValue(1)).toBe(1);
  expect(redactValue(true)).toBe(true);
  expect(redactValue(null)).toBe(null);
  expect(redactValue(undefined)).toBe(undefined);
});

test('redactValue: never throws on a circular object graph', () => {
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  let out: unknown;
  expect(() => {
    out = redactValue(circular);
  }).not.toThrow();
  expect(() => JSON.stringify(out)).not.toThrow();
  expect((out as Record<string, unknown>).self).toBe('[Circular]');
});

test('redactValue: never throws on a circular array', () => {
  const circular: unknown[] = [1, 2];
  circular.push(circular);
  let out: unknown[] = [];
  expect(() => {
    out = redactValue(circular);
  }).not.toThrow();
  expect(out[2]).toBe('[Circular]');
});

// --- redactError -------------------------------------------------------------------

test('redactError: a new Error keeping name and code, with its message redacted and its cause chain copied', () => {
  const inner = Object.assign(new Error('reset reaching https://x.blob/f?sig=INNERSIG'), {
    code: 'ECONNRESET',
  });
  const outer = new TypeError('fetch failed for https://x.blob/g?sig=OUTERSIG', { cause: inner });

  const copy = redactError(outer);

  expect(copy).not.toBe(outer);
  expect(copy.name).toBe('TypeError');
  expect(copy.message).toBe('fetch failed for https://x.blob/g');
  const copiedInner = copy.cause as Error & { code?: unknown };
  expect(copiedInner).not.toBe(inner);
  expect(copiedInner.code).toBe('ECONNRESET');
  expect(copiedInner.message).toBe('reset reaching https://x.blob/f');
  expect(inspect(copy, { depth: null })).not.toMatch(/INNERSIG|OUTERSIG/);
});

test('redactError: a numeric code is kept, the cause chain stops after four levels, and a non-Error becomes one', () => {
  const abort = new DOMException('This operation was aborted', 'AbortError');
  expect(redactError(abort)).toMatchObject({ name: 'AbortError', code: 20 });

  let chain: Error = new Error('level 5');
  for (const level of [4, 3, 2, 1]) chain = new Error(`level ${level}`, { cause: chain });
  const copy = redactError(chain);
  const messages: string[] = [];
  for (let current: unknown = copy; current instanceof Error; current = current.cause) {
    messages.push(current.message);
  }
  expect(messages).toEqual(['level 1', 'level 2', 'level 3', 'level 4']);

  const fromString = redactError('boom at https://x.blob/f?sig=STRINGSIG');
  expect(fromString).toBeInstanceOf(Error);
  expect(fromString.message).toBe('boom at https://x.blob/f');
  expect(redactError(Symbol('reason')).message).toBe('Symbol(reason)');
});

test('redactError: never throws, even for an error whose properties throw', () => {
  const hostile = new Error('hidden');
  Object.defineProperty(hostile, 'message', {
    get() {
      throw new Error('getter exploded');
    },
  });
  expect(redactError(hostile)).toBeInstanceOf(Error);
  expect(redactError(hostile).message).toBe('[Unreadable error]');
});

// --- AudioVideoError --------------------------------------------

test('AudioVideoError: redacts message + items; secrets never survive JSON.stringify, toString, or util.inspect', () => {
  const err = new AudioVideoError({
    message: 'Render failed for https://x.blob/f?sig=SECRETSIG&se=2026, retry exhausted',
    code: 'render_failed',
    status: 403,
    jobId: 'job-1',
    requestId: 'req-1',
    cause: new Error('network reset'),
    items: [{ headers: { authorization: 'Bearer SECRETTOKEN' }, note: 'item detail' }],
  });

  const serialized = [JSON.stringify(err), err.toString(), inspect(err)];
  for (const s of serialized) {
    expect(s).not.toContain('SECRETSIG');
    expect(s).not.toContain('sig=');
    expect(s).not.toContain('Bearer');
    expect(s).not.toContain('SECRETTOKEN');
  }

  expect(err).toBeInstanceOf(AudioVideoError);
  expect(err).toBeInstanceOf(Error);
  expect(err.code).toBe('render_failed');
  expect(err.cause).toBeInstanceOf(Error);
  expect((err.cause as Error).message).toBe('network reset');
});

test('AudioVideoError: .code defaults to a stable value when omitted', () => {
  const err = new AudioVideoError({ message: 'boom' });
  expect(err.code).toBe('audio_video_error');
});

test('AudioVideoError: toJSON returns only the documented, redacted fields', () => {
  const err = new AudioVideoError({
    message: 'https://x/f?sig=SECRET failed',
    code: 'X',
    status: 500,
    jobId: 'j',
    requestId: 'r',
    items: [1, 2],
  });
  expect(err.toJSON()).toEqual({
    name: 'AudioVideoError',
    code: 'X',
    status: 500,
    jobId: 'j',
    requestId: 'r',
    message: 'https://x/f failed',
    items: [1, 2],
  });
});
