import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The console is served by the loopback control API (M08) from the same origin as
// /__routespec/v1, so the build uses relative asset URLs and never references a remote host.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // Keep every asset as a separate same-origin file so the strict CSP (no data: fonts,
    // no inline script) applies without exceptions.
    assetsInlineLimit: 0,
    target: 'es2022',
  },
  server: {
    host: '127.0.0.1',
    strictPort: true,
  },
});
