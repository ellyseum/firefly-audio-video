import { inspect } from 'node:util';
import { expect, test } from 'vitest';
import { redactUrl, redactHeaders, redactValue } from '../src/core/redact.js';
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

test('redactUrl: never throws on a malformed URL, and still redacts what it can', () => {
  const input = 'http://[bad-host]?sig=SECRET&rest=keep';
  let out = '';
  expect(() => {
    out = redactUrl(input);
  }).not.toThrow();
  expect(out).not.toContain('SECRET');
  expect(out).toContain('rest=keep');
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

// --- AudioVideoError --------------------------------------------

test('AudioVideoError: redacts message + items; secrets never survive JSON.stringify, toString, or util.inspect', () => {
  const err = new AudioVideoError({
    message: 'Render failed for https://x.blob/f?sig=SECRETSIG&se=2026, retry exhausted',
    code: 'RENDER_FAILED',
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
  expect(err.code).toBe('RENDER_FAILED');
  expect(err.cause).toBeInstanceOf(Error);
  expect((err.cause as Error).message).toBe('network reset');
});

test('AudioVideoError: .code defaults to a stable value when omitted', () => {
  const err = new AudioVideoError({ message: 'boom' });
  expect(err.code).toBe('AUDIO_VIDEO_ERROR');
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
