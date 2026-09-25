import swc from 'unplugin-swc';
import { coverage } from '@sm/config/vitest';
import { defineConfig } from 'vitest/config';

// SWC keeps decorator metadata, which NestJS dependency injection relies on.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    coverage: coverage(),
  },
});
