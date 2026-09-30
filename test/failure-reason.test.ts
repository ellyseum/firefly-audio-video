import { describe, expect, test } from 'vitest';
import { failureReason, withFailureReason } from '../src/core/failure-reason.js';

const MISSING_FONT = {
  code: 'missing_font',
  message: 'The template uses font AdobeClean-Bold, which must be uploaded with the render.',
};

describe('failureReason', () => {
  test("a failed job's entry gives its first error's code and message", () => {
    expect(failureReason([{ index: 0, errors: [MISSING_FONT, { code: 'other' }] }])).toBe(
      'missing_font: The template uses font AdobeClean-Bold, which must be uploaded with the render.',
    );
  });

  test.each<[label: string, entry: unknown, reason: string]>([
    [
      'a gateway body',
      { error_code: '403003', message: 'Api Key is invalid' },
      '403003: Api Key is invalid',
    ],
    [
      'a numeric code',
      { error_code: 429050, message: 'Too many requests' },
      '429050: Too many requests',
    ],
    [
      'an OAuth-style body',
      { error: 'invalid_client', error_description: 'bad secret' },
      'invalid_client: bad secret',
    ],
    [
      'a detail body',
      { error: 'bad_gateway', detail: 'upstream closed' },
      'bad_gateway: upstream closed',
    ],
    ['a code alone', { code: 'QUOTA_EXCEEDED' }, 'QUOTA_EXCEEDED'],
    ['a message alone', { message: 'job not found' }, 'job not found'],
    ['a text body', 'Service Unavailable', 'Service Unavailable'],
    [
      'an entry with neither',
      { status: 'broken', retry: false },
      '{"status":"broken","retry":false}',
    ],
  ])('reads %s', (_label, entry, reason) => {
    expect(failureReason([entry])).toBe(reason);
  });

  test('collapses a multi-line reason to one line', () => {
    expect(failureReason(['<html>\n  <body>\tBad   Gateway</body>\n</html>'])).toBe(
      '<html> <body> Bad Gateway</body> </html>',
    );
  });

  test('cuts a reason longer than 200 characters to 200, ending in an ellipsis', () => {
    const reason = failureReason([{ code: 'long', message: 'x'.repeat(500) }]);
    expect(reason).toHaveLength(200);
    expect(reason?.startsWith('long: xxx')).toBe(true);
    expect(reason?.endsWith('…')).toBe(true);
  });

  test('keeps a reason of exactly 200 characters whole', () => {
    const message = 'y'.repeat(200 - 'c: '.length);
    expect(failureReason([{ code: 'c', message }])).toBe(`c: ${message}`);
  });

  test('is undefined, never a throw, for an entry that cannot be written as JSON', () => {
    expect(failureReason([{ count: 10n }])).toBeUndefined();
    expect(withFailureReason('m.', [{ count: 10n }])).toBe('m.');
  });

  test('is undefined when there are no items, or none carries a reason', () => {
    expect(failureReason(undefined)).toBeUndefined();
    expect(failureReason([])).toBeUndefined();
    expect(failureReason([{ index: 0, errors: [] }])).toBeUndefined();
  });
});

describe('withFailureReason', () => {
  test('appends the one reason the items carry', () => {
    expect(
      withFailureReason('Job job-1 failed: errors on output 0.', [
        { index: 0, errors: [MISSING_FONT] },
      ]),
    ).toBe(
      'Job job-1 failed: errors on output 0. Reason: missing_font: The template uses font AdobeClean-Bold, which must be uploaded with the render.',
    );
  });

  test('says "First reason" when the items carry more than one', () => {
    expect(withFailureReason('m.', [{ index: 0, errors: [{ code: 'A' }, { code: 'B' }] }])).toBe(
      'm. First reason: A',
    );
    expect(
      withFailureReason('m.', [
        { index: 0, errors: [{ code: 'A' }] },
        { index: 2, errors: [{ code: 'C' }] },
      ]),
    ).toBe('m. First reason: A');
  });

  test('leaves the message as it is when the items carry no reason', () => {
    expect(withFailureReason('m.', undefined)).toBe('m.');
    expect(withFailureReason('m.', [])).toBe('m.');
  });
});
