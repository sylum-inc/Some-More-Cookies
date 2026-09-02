import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/*/test/**/*.test.ts',
      'services/*/test/**/*.test.ts',
      'apps/web/test/**/*.test.ts',
      // Seam tests: they boot the real service and drive it with the real
      // client, so they belong to neither half and live at the root.
      'test/integration/**/*.test.ts',
    ],
    /*
     * Measured for the first time in this project's life, and the `include`
     * widened when it was.
     *
     * The provider was never installed, so this block had never run — the
     * config described a measurement nobody had taken. Worse, the original
     * globs covered only `packages/` and `services/`, which meant that even
     * once it did run it would have reported a confident number about two
     * thirds of the codebase while saying nothing at all about the largest
     * third: the renderer, the audio engine and the UI in `apps/web`.
     *
     * `apps/web` scores low here on purpose. Most of it is exercised by
     * Playwright in a real browser rather than by Vitest, and this number
     * cannot see that. It is reported anyway, because "not measured by unit
     * tests" is a fact worth having in front of you, and a coverage report
     * that quietly omits the hardest part of the system is the kind of
     * reassurance that is worse than no reassurance.
     */
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['packages/*/src/**/*.ts', 'services/*/src/**/*.ts', 'apps/*/src/**/*.{ts,tsx}'],
    },
  },
  resolve: {
    alias: {
      '@somemore/sim': new URL('./packages/sim/src/index.ts', import.meta.url).pathname,
      '@somemore/content': new URL('./packages/content/src/index.ts', import.meta.url).pathname,
      '@somemore/protocol': new URL('./packages/protocol/src/index.ts', import.meta.url).pathname,
    },
  },
});
