import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Two entry points: the marketing landing (served at /) and the editor app
// (served at /app and for /d/:id share links). Both build into dist/.
export default defineConfig({
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        landing: resolve(__dirname, 'landing.html'),
        app: resolve(__dirname, 'index.html'),
        spec: resolve(__dirname, 'tifo-spec.html'),
      },
    },
  },
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
});
