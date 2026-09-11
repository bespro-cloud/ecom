import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the storefront's pure logic.
 *
 * Components are not rendered here. The parts worth testing — Markdown link
 * safety, JSON-LD escaping and payload shape, facet URL construction — were
 * deliberately extracted into plain modules so they can be tested without a DOM
 * or a React renderer.
 */
export default defineConfig({
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
