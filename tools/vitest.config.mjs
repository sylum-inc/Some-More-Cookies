import { defineConfig } from 'vitest/config';

/**
 * Tests for the tools themselves.
 *
 * Separate from the root `vitest.config.ts` on purpose: `npm test` is the
 * product's own suite and should stay that. These are the tests that prove
 * the *measuring instruments* work — an audio analyser that reports the wrong
 * spectral centroid, or a frame-health rule that never fires, is worse than no
 * check at all, because it produces confident green output about nothing.
 *
 * Run: `npm run test:tools`
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tools/**/*.test.{js,mjs,ts}'],
    exclude: ['**/node_modules/**', 'tools/**/.build/**'],
  },
});
