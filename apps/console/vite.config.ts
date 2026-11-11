import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The console is served by the loopback control API (M08) from the same origin as
// /__routespec/v1, so the build uses relative asset URLs and never references a remote host.
export default defineConfig(({ command }) => {
  // A shipped console is always a production build. An inherited NODE_ENV (for example `test`
  // from a test runner or `development` from a shell profile) would otherwise select the
  // development JSX transform, which embeds absolute source file paths of the build machine
  // in the bundle (found by the M12 clean-install check, T-054).
  if (command === 'build') process.env['NODE_ENV'] = 'production';
  return {
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
  };
});
