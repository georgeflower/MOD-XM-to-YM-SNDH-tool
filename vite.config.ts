/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The page must also work when index.html is simply double-clicked (file://), where browsers refuse
// module scripts and `crossorigin` requests. So: one classic (IIFE) script loaded with `defer`.
const classicScript = (): Plugin => ({
  name: 'classic-script',
  enforce: 'post',
  transformIndexHtml(html) {
    return html
      .replace(/<script type="module" crossorigin/g, '<script defer')
      .replace(/<link rel="stylesheet" crossorigin/g, '<link rel="stylesheet"');
  },
});

// base './' => every asset URL is relative, so the built folder works from any sub-path
// (e.g. https://user.nekoweb.org/apps/mod2ym/ AND .../apps/mod2ym/index.html) and from file://.
export default defineConfig({
  base: './',
  plugins: [react(), classicScript()],
  assetsInclude: ['**/*.mod', '**/*.xm'],
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: { output: { format: 'iife' } },
  },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 120000 },
});
