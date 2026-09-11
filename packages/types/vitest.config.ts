import { defineConfig } from 'vitest/config';

/**
 * Pure logic only: state machines, money allocation and the pricing engine.
 * Nothing in this package touches a database, which is exactly why the rules
 * that decide what a customer is charged live here.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
