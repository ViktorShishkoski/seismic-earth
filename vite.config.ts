/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the same build works at a domain root
  // (Cloudflare Pages) or under a sub-path (GitHub Pages: /seismic-earth/).
  base: './',
  server: {
    open: true,
  },
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'server/test/**/*.test.ts'],
  },
});
