import { coverage } from '@sm/config/vitest';
import { defineConfig } from 'vitest/config';

// RecordService runs against a real cell database (Testcontainers, or TEST_PG_SERVER_ADMIN_URL).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    coverage: coverage({ lines: 85 }),
  },
});
