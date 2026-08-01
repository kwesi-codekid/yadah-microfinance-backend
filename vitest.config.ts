import { defineConfig } from 'vitest/config';

// Default suite: pure unit tests only. Integration tests (real DB) live in
// tests/integration and run via `npm run test:integration`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
