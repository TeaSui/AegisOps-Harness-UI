import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The client is built ahead of time and served by the Aegis server. Nothing is loaded from a remote host.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2022', assetsInlineLimit: 0 },
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:4317', changeOrigin: false } } },
});
