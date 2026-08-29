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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['packages/*/src/**/*.ts', 'services/*/src/**/*.ts'],
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
