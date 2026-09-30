/**
 * How the package entry lets a caller type what a job-running call returns:
 * the `JobHandle` type every such handle satisfies, and no class that no call
 * returns — an `instanceof` against one would be false for every handle.
 */

import { expect, expectTypeOf, test } from 'vitest';
import * as sdk from '../src/index.js';
import type { Asset, JobHandle, RenderBuilder, RenderJob } from '../src/index.js';

test('the package entry types the handle a job-running call returns, and exports no job class', () => {
  expect(Object.keys(sdk)).not.toContain('AsyncJob');
  expectTypeOf<RenderJob<string>>().toEqualTypeOf<JobHandle<string>>();
  expectTypeOf<RenderBuilder>().toExtend<JobHandle<Asset>>();
});
