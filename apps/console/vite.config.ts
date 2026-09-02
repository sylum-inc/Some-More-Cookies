import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const pkg = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * The console is a **separate build** from the player client, on a separate
 * port, and that is the whole security posture — see `src/ops.ts` for the
 * reasoning. Nothing here is imported by `apps/web` and nothing in `apps/web`
 * is imported by this.
 *
 * There is deliberately no `VITE_LIVE_OPS_TOKEN`. The ops token is typed in by
 * a person and held in `sessionStorage` for the length of a tab; a build-time
 * variable would put a shared staff secret into a static asset, and static
 * assets get served, cached and copied.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@somemore/protocol': pkg('../../packages/protocol/src/index.ts'),
      '@somemore/content': pkg('../../packages/content/src/index.ts'),
      '@somemore/sim': pkg('../../packages/sim/src/index.ts'),
    },
  },
  server: { host: '127.0.0.1', port: 5174 },
  preview: { host: '127.0.0.1', port: 4174 },
  build: { target: 'es2022', sourcemap: true },
});
