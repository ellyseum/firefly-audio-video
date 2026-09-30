import { defaultExclude, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // The live smoke suite runs only under vitest.smoke.config.ts (`npm run smoke`).
    exclude: [...defaultExclude, 'test/smoke/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      thresholds: {
        statements: 94,
        branches: 89,
        functions: 96,
        lines: 95,
      },
    },
  },
});
