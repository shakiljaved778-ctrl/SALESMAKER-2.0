import { coverage } from '@sm/config/vitest';
import { defineConfig } from 'vitest/config';

// §13: the Query Engine is held to 90% line coverage.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    coverage: coverage({ lines: 90 }),
  },
});
