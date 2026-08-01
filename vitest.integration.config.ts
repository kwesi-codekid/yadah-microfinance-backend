import { defineConfig } from 'vitest/config';

// Integration suite (WBS 7.2): runs against the yadah-test database on the
// real replica set so Mongo transactions behave exactly as in production.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/integration/setup.ts'],
    fileParallelism: false, // one DB — run files sequentially
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
