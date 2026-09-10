import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Integration tests share one database; running files in parallel would
    // make truncation between suites race.
    fileParallelism: false,
  },
});
