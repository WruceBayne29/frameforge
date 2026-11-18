/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages (/frameforge/) and locally.
export default defineConfig({
  base: './',
  plugins: [react()],
  // The app chunk includes three.js (~1.1 MB, ~300 kB gzipped); the PDF report is a separate
  // chunk loaded on demand.
  build: { chunkSizeWarningLimit: 1200 },
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
