/**
 * A {@link Client} test double: every network-facing method comes from
 * `overrides`, or fails loudly if a test invokes it without stubbing it, so
 * no CLI command test ever builds a real client or touches the network.
 * `presets`/`encode`/`resize` are the SDK's own implementations — they need
 * no credential and are safe to reuse as-is.
 *
 * Each override is typed `unknown` rather than the real (heavily overloaded)
 * method signature: a test's mock only ever needs to match the ONE call
 * shape that test exercises, and the overloaded `Client` type is not
 * something a single mock function can satisfy structurally. The cast to
 * `Client` happens once, here, for exactly this reason.
 */

import { vi } from 'vitest';
import { encode, presets, resize } from '../../../src/dgr/preset.js';
import type { Client } from '../../../src/dgr/client.js';

/** Throws loudly when a test invokes a method it never stubbed. */
function unstubbed(name: string): () => never {
  return () => {
    throw new Error(`fake client: ${name}() was not stubbed for this test`);
  };
}

/** One override per network-facing {@link Client} method, each shaped however that test needs it called. */
export interface FakeClientOverrides {
  render?: unknown;
  describe?: unknown;
  listPresets?: unknown;
  status?: unknown;
  cancel?: unknown;
  stage?: unknown;
}

/** A {@link Client} double with `overrides` layered over methods that fail loudly if called unstubbed. */
export function createFakeClient(overrides: FakeClientOverrides = {}): Client {
  const base = {
    presets,
    encode,
    resize,
    render: overrides.render ?? unstubbed('render'),
    describe: overrides.describe ?? unstubbed('describe'),
    listPresets: overrides.listPresets ?? vi.fn(async () => unstubbed('listPresets')()),
    status: overrides.status ?? vi.fn(async () => unstubbed('status')()),
    cancel: overrides.cancel ?? vi.fn(async () => unstubbed('cancel')()),
    stage: overrides.stage ?? vi.fn(async () => unstubbed('stage')()),
  };
  return base as unknown as Client;
}
