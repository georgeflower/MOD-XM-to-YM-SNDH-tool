/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' => every asset URL is relative, so the built folder works from any sub-path
// (e.g. https://user.nekoweb.org/apps/mod2ym/ AND .../apps/mod2ym/index.html).
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { target: 'es2022', outDir: 'dist' },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 120000 },
});
