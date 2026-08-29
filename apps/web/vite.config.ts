import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const pkg = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@somemore/sim': pkg('../../packages/sim/src/index.ts'),
      '@somemore/content': pkg('../../packages/content/src/index.ts'),
      '@somemore/protocol': pkg('../../packages/protocol/src/index.ts'),
    },
  },
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
  build: { target: 'es2022', sourcemap: true },
});
