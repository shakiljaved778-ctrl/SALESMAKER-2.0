import { coverage } from '@sm/config/vitest';
import { defineConfig } from 'vitest/config';

// §13: the permission engine is held to 90% line coverage.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], coverage: coverage({ lines: 90 }) },
});
