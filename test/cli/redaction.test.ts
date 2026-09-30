/**
 * Every error message the CLI prints goes through the shared redaction: a
 * non-SDK error a command rejects with, a thrown non-Error value, an error
 * that escapes a command's own handling, and commander's usage text.
 */

import { expect, test, vi } from 'vitest';
import { createFakeClient } from './support/fake-client.js';
import { createHarness } from './support/harness.js';

const SIGNATURE = 'PLAIN_ERROR_SIGNATURE';
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJjbGkifQ.c2lnbmF0dXJlLWJ5dGVz';
const URL_BASE = 'https://storage.example.test/f.mov';
const LEAKY = `lookup of ${URL_BASE}?sv=2021&sig=${SIGNATURE} failed; Authorization: Bearer ${JWT}`;

function expectRedacted(printed: string): void {
  expect(printed).not.toContain(SIGNATURE);
  expect(printed).not.toContain(JWT);
  expect(printed).toContain('Bearer REDACTED');
  expect(printed).toContain(URL_BASE);
}

function stdoutDocuments(text: string): unknown[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown);
}

test('a plain Error a command rejects with prints redacted, with code unexpected_error, exit 1', async () => {
  const client = createFakeClient({ status: vi.fn(async () => Promise.reject(new Error(LEAKY))) });
  const harness = createHarness({ client });
  await harness.run(['status', 'job-1']);
  expectRedacted(harness.stderrText());
  expect(harness.stderrText()).toContain('Code: unexpected_error');
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(1);
});

test('a plain Error a command rejects with prints redacted in the --json failure document', async () => {
  const client = createFakeClient({ status: vi.fn(async () => Promise.reject(new Error(LEAKY))) });
  const harness = createHarness({ client });
  await harness.run(['status', 'job-1', '--json']);
  expectRedacted(harness.stdoutText());
  expect(stdoutDocuments(harness.stdoutText())).toEqual([
    { ok: false, error: { code: 'unexpected_error', message: expect.any(String) } },
  ]);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(1);
});

test('a thrown value that is not an Error prints redacted', async () => {
  const client = createFakeClient({ status: vi.fn(async () => Promise.reject(LEAKY)) });
  const harness = createHarness({ client });
  await harness.run(['status', 'job-1']);
  expectRedacted(harness.stderrText());
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(1);
});

test("an error escaping a command's own handling prints redacted, and as one document under --json", async () => {
  const human = createHarness();
  human.program.command('boom').action(() => {
    throw new Error(LEAKY);
  });
  await human.run(['boom']);
  expectRedacted(human.stderrText());
  expect(human.exit).toHaveBeenCalledExactlyOnceWith(1);

  const json = createHarness();
  json.program.command('boom').action(() => {
    throw new Error(LEAKY);
  });
  await json.run(['boom', '--json']);
  expectRedacted(json.stdoutText());
  expect(stdoutDocuments(json.stdoutText())).toEqual([
    { ok: false, error: { code: 'unexpected_error', message: expect.any(String) } },
  ]);
  expect(json.stderrText()).toBe('');
  expect(json.exit).toHaveBeenCalledExactlyOnceWith(1);
});

test("commander's usage text is redacted: a presigned URL typed as a command loses its signature", async () => {
  const harness = createHarness();
  await harness.run([`${URL_BASE}?sv=2021&sig=${SIGNATURE}`]);
  expect(harness.stderrText()).toContain(`error: unknown command '${URL_BASE}'`);
  expect(harness.stderrText()).not.toContain(SIGNATURE);
  expect(harness.exit).toHaveBeenCalledExactlyOnceWith(2);
});
