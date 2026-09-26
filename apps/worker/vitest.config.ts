import { coverage } from '@sm/config/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // main.ts and instrument.ts only wire the process; createWorker (tested) does the work.
    coverage: coverage({ exclude: ['src/main.ts', 'src/instrument.ts'] }),
  },
});
