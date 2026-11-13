import { defineConfig } from 'vite';

// A static page for GitHub Pages: relative asset URLs (it is served under /<repository>/), no
// source maps, every asset a separate same-origin file so the meta CSP needs no exception.
export default defineConfig(({ command }) => {
  if (command === 'build') process.env['NODE_ENV'] = 'production';
  return {
    base: './',
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
      assetsInlineLimit: 0,
      modulePreload: { polyfill: false },
      target: 'es2022',
    },
    server: { host: '127.0.0.1', strictPort: true },
  };
});
