import { defineConfig } from 'vitest/config';

// The live smoke suite: real renders, run by `npm run smoke` and kept out of `npm test`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/smoke/**/*.test.ts'],
    // A render queues, encodes on the service and downloads; the farm has held a job in its
    // queue for 45 minutes before rendering it in 28 seconds.
    testTimeout: 55 * 60_000,
    hookTimeout: 5 * 60_000,
  },
});
