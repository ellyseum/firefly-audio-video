import { inspect } from 'node:util';
import { expect, test } from 'vitest';
import { redactError, redactUrl, redactHeaders, redactValue } from '../src/core/redact.js';
import { AudioVideoError, type AudioVideoErrorOptions } from '../src/core/errors.js';

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

// --- every credential-bearing parameter ------------------------------------------------

const SECRET_PARAMS = [
  // Azure SAS
  ...['sig', 'se', 'sp', 'sv', 'sr', 'st', 'spr', 'sip', 'si', 'srt', 'ss'],
  ...['skoid', 'sktid', 'skt', 'ske', 'sks', 'skv', 'saoid', 'suoid', 'scid', 'skdutid', 'sduoid'],
  ...['sdd', 'ses'],
  // AWS SigV4 and SigV2
  ...['X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Expires'],
  ...[
    'X-Amz-SignedHeaders',
    'X-Amz-Signature',
    'X-Amz-Security-Token',
    'AWSAccessKeyId',
    'Signature',
  ],
  // Google Cloud Storage V4 and V2
  ...['X-Goog-Algorithm', 'X-Goog-Credential', 'X-Goog-Date', 'X-Goog-Expires'],
  ...['X-Goog-SignedHeaders', 'X-Goog-Signature', 'GoogleAccessId'],
  // tokens, secrets, passwords, credentials and keys
  ...['access_token', 'refresh_token', 'id_token', 'token', 'client_secret', 'password', 'passwd'],
  ...['credential', 'api_key', 'apikey', 'api-key', 'private_key', 'key'],
];

test.each(SECRET_PARAMS)(
  'the %s query parameter is removed from a URL, and from a URL in text',
  (name) => {
    const url = `https://h.example/f?${name}=SECRET_VALUE&rest=keep`;
    expect(redactUrl(url)).toBe('https://h.example/f?rest=keep');
    expect(redactValue(`see ${url} now`)).toBe('see https://h.example/f?rest=keep now');
  },
);

test('benign parameters survive, including ones whose names merely resemble a secret name', () => {
  const url =
    'https://h.example/f?rest=keep&format=mp4&width=1920&page=2&keyframe=10&monkey=1&sigma=3&expires=2026';
  expect(redactUrl(url)).toBe(url);
  expect(redactValue(`see ${url} now`)).toBe(`see ${url} now`);
});

test.each([
  [
    'an &amp;-escaped separator in an HTML body',
    '<a href="https://h.example/f?sv=1&amp;sig=HTMLSIG&amp;rest=keep">',
    '<a href="https://h.example/f?&amp;rest=keep">',
  ],
  [
    'a presigned URL percent-encoded inside another URL',
    'https://h.example/login?next=https%3A%2F%2Fs.example%2Ff%3Fsv%3D1%26sig%3DNESTEDSIG%26rest%3Dkeep',
    'https://h.example/login?next=https%3A%2F%2Fs.example%2Ff%3F%26rest%3Dkeep',
  ],
  ['a bare SAS query string', 'query: sv=2021&sp=r&sig=BARESIG&rest=keep', 'query: &rest=keep'],
  [
    'a client-credentials form body',
    'grant_type=client_credentials&client_id=abc&client_secret=FORMSECRET&scope=openid',
    'grant_type=client_credentials&client_id=abc&scope=openid',
  ],
  [
    'a protocol-relative URL in text',
    'see //h.example/f?sig=PRSIG&rest=keep',
    'see //h.example/f?&rest=keep',
  ],
])('%s loses its secret', (_case, input, expected) => {
  expect(redactValue(input)).toBe(expected);
});

test('user info is removed from a URL, a URL in text, another scheme, and an unparseable URL', () => {
  expect(redactUrl('https://svc:USERINFO_PASS@proxy.example.com/v1/presets')).toBe(
    'https://proxy.example.com/v1/presets',
  );
  expect(redactValue('proxy https://svc:USERINFO_PASS@proxy.example.com/v1 failed')).toBe(
    'proxy https://proxy.example.com/v1 failed',
  );
  expect(redactValue('db postgres://admin:DB_PASS@db.internal:5432/app is down')).toBe(
    'db postgres://db.internal:5432/app is down',
  );
  expect(redactUrl('http://user:RAW_PASS@[bad-host/x?sig=RAWSIG')).toBe('http://[bad-host/x');
  // A password holding an `@` goes up to the last `@` before the host.
  expect(redactUrl('https://svc:P@SS_WORD@proxy.example.com/v1')).toBe(
    'https://proxy.example.com/v1',
  );
});

test('redactUrl on its own removes a ;-separated signature and one percent-encoded in another parameter', () => {
  expect(redactUrl('https://h.example/f?a=1;sig=SEMISIG')).toBe('https://h.example/f?a=1');
  expect(
    redactUrl('https://h.example/login?next=https%3A%2F%2Fs.example%2Ff%3Fsig%3DNESTEDSIG'),
  ).toBe('https://h.example/login?next=https%3A%2F%2Fs.example%2Ff%3F');
});

test('a Bearer credential and a JWT in free text are replaced; a lowercase word after "bearer" is prose', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SIGNATURE_PART';
  expect(redactValue(`Authorization: Bearer ${jwt}`)).toBe('Authorization: Bearer REDACTED');
  expect(redactValue('authorization: bearer FAKE_TOKEN_123 sent')).toBe(
    'authorization: bearer REDACTED sent',
  );
  expect(redactValue(`token ${jwt} was rejected`)).toBe('token REDACTED was rejected');
  expect(redactValue('the bearer token was rejected')).toBe('the bearer token was rejected');
});

test.each([
  'authorization',
  'Authorization',
  'x-api-key',
  'apiKey',
  'api_key',
  'token',
  'accessToken',
  'client_secret',
  'password',
  'passwd',
  'cookie',
  'set-cookie',
  'sig',
  'signature',
  'credential',
  'credentials',
  'private_key',
  'privateKey',
  'bearer',
])('a value under the key %s is replaced, in an object and in a header set', (key) => {
  expect(redactValue({ [key]: 'SECRET_VALUE', note: 'kept' })).toEqual({
    [key]: 'REDACTED',
    note: 'kept',
  });
  expect(redactHeaders({ [key]: 'SECRET_VALUE', accept: 'application/json' })).toEqual({
    [key]: 'REDACTED',
    accept: 'application/json',
  });
});

test('a URL used as an object key loses its signature too', () => {
  expect(redactValue({ 'https://h.example/f?sig=KEYSIG&rest=keep': 1 })).toEqual({
    'https://h.example/f?rest=keep': 1,
  });
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

test('redactValue: never throws on a throwing getter, a throwing Proxy trap or a revoked Proxy', () => {
  const withGetter = {
    ok: 'https://h.example/f?sig=GETTERSIG',
    get boom(): string {
      throw new Error('getter exploded');
    },
  };
  expect(redactValue(withGetter)).toEqual({ ok: 'https://h.example/f', boom: '[Unreadable]' });

  const trapped = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('ownKeys exploded');
      },
    },
  );
  expect(redactValue({ trapped, kept: 1 })).toEqual({ trapped: '[Unreadable]', kept: 1 });

  const { proxy, revoke } = Proxy.revocable([1, 2], {});
  revoke();
  expect(redactValue([proxy, 'kept'])).toEqual(['[Unreadable]', 'kept']);
});

test('AudioVideoError: construction never throws — hostile items, a throwing option getter, no options at all', () => {
  const hostileItem = {
    get boom(): string {
      throw new Error('getter exploded');
    },
  };
  const withItems = new AudioVideoError({ message: 'm', code: 'c', items: [hostileItem] });
  expect(withItems.items).toEqual([{ boom: '[Unreadable]' }]);

  const options = {
    code: 'kept_code',
    get message(): string {
      throw new Error('message getter exploded');
    },
  };
  const withGetter = new AudioVideoError(options);
  expect(withGetter.code).toBe('kept_code');
  expect(withGetter.message).toBe('');

  const withNothing = new AudioVideoError(null as unknown as AudioVideoErrorOptions);
  expect(withNothing.code).toBe('audio_video_error');
  expect(withNothing.message).toBe('');
  expect(new AudioVideoError({ message: 42 as unknown as string }).message).toBe('42');
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

test('AudioVideoError: util.inspect prints neither a secret-bearing cause nor the stack', () => {
  const err = new AudioVideoError({
    message: 'Request failed.',
    code: 'request_failed',
    cause: new Error('reset reaching https://h.example/f?sig=CAUSESIG'),
  });

  const printed = inspect(err, { depth: null });

  expect(printed).not.toContain('CAUSESIG');
  expect(printed).not.toMatch(/\n\s+at /);
  expect(printed).toContain('request_failed');
});

test('AudioVideoError: a subclass instance is instanceof the subclass, AudioVideoError and Error', () => {
  class RenderQuotaError extends AudioVideoError {
    retryLater(): boolean {
      return this.code === 'render_quota';
    }
  }

  const err = new RenderQuotaError({ message: 'quota reached', code: 'render_quota' });

  expect(err).toBeInstanceOf(RenderQuotaError);
  expect(err).toBeInstanceOf(AudioVideoError);
  expect(err).toBeInstanceOf(Error);
  expect(err.retryLater()).toBe(true);
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
