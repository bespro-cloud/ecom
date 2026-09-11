import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    testTimeout: 30000,
    // The S3 suite binds a port; running files in parallel would collide.
    fileParallelism: false,
  },
});
