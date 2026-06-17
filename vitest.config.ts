import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // DB-backed tests run serially against the local docker Postgres to keep
    // row-count assertions deterministic.
    fileParallelism: false,
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
  },
});
