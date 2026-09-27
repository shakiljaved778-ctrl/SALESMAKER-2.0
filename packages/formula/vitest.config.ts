import { coverage } from '@sm/config/vitest';
import { defineConfig } from 'vitest/config';

// §13: the formula engine is held to 90% line coverage. The SQL compiler is checked against the
// evaluator on a real Postgres (Testcontainers, or TEST_PG_SERVER_ADMIN_URL).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    coverage: coverage({ lines: 90 }),
  },
});
