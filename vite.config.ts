import { defineConfig } from 'vite';

export default defineConfig({
  build: { target: 'es2022' },
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
});
