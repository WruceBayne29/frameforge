/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages (/frameforge/) and locally.
export default defineConfig({
  base: './',
  plugins: [react()],
  // three.js makes the lazily loaded 3D workspace chunk ~760 kB; the 2D first load is unaffected.
  build: { chunkSizeWarningLimit: 800 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/solver/**/*.ts', 'src/solver3d/**/*.ts', 'src/design-codes/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/types.ts', '**/contract.ts'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 80 },
    },
  },
});
