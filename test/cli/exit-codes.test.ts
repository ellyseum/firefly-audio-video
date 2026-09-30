import { expect, test } from 'vitest';
import { AudioVideoError } from '../../src/core/errors.js';
import { EXIT_CODES, exitCodeForError, exitCodesHelpText } from '../../src/cli/exit-codes.js';

function errorOf(code: string): AudioVideoError {
  return new AudioVideoError({ message: 'x', code });
}

test.each<[code: string, expected: number]>([
  ['invalid_argument', 2],
  ['invalid_preset', 2],
  ['missing_peer_dependency', 2],
  ['auth_failed', 3],
  ['job_failed', 4],
  ['job_timeout', 4],
  ['invalid_response', 4],
  ['request_failed', 5],
  ['request_timeout', 5],
  ['submit_failed', 5],
  ['job_poll_failed', 5],
  ['asset_fetch_failed', 5],
  ['storage_failed', 5],
  ['http_404', 5],
  ['http_429', 5],
  ['http_500', 5],
])('%s maps to exit code %i', (code, expected) => {
  expect(exitCodeForError(errorOf(code))).toBe(expected);
});

test('cancelled maps to 4 when this process did not initiate it', () => {
  expect(exitCodeForError(errorOf('cancelled'))).toBe(4);
  expect(exitCodeForError(errorOf('cancelled'), { cancelledByUser: false })).toBe(4);
});

test('cancelled maps to 130 when this process initiated it', () => {
  expect(exitCodeForError(errorOf('cancelled'), { cancelledByUser: true })).toBe(130);
});

test('a plain thrown Error maps to 1', () => {
  expect(exitCodeForError(new Error('boom'))).toBe(1);
});

test('a non-Error thrown value maps to 1', () => {
  expect(exitCodeForError('boom')).toBe(1);
  expect(exitCodeForError(undefined)).toBe(1);
  expect(exitCodeForError({ code: 'auth_failed' })).toBe(1);
});

test('an unrecognized AudioVideoError code maps to 1', () => {
  expect(exitCodeForError(errorOf('audio_video_error'))).toBe(1);
  expect(exitCodeForError(errorOf('something_new'))).toBe(1);
});

test('every code in the table appears in the help text, in order, with its own line', () => {
  const text = exitCodesHelpText();
  expect(text.startsWith('Exit codes:\n')).toBe(true);
  const lines = text.split('\n').slice(1);
  expect(lines).toHaveLength(EXIT_CODES.length);
  EXIT_CODES.forEach((entry, index) => {
    expect(lines[index]).toContain(String(entry.code));
    expect(lines[index]).toContain(entry.meaning);
  });
});
