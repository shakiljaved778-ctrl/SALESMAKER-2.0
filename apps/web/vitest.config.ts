import { coverage } from '@sm/config/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The unit gate covers the BFF (src/server): cookies, CSRF, tenant resolution, OIDC state.
    // Pages, components and the browser session code are covered by the e2e journeys (e2e/).
    coverage: coverage({ include: ['src/server/**/*.ts'] }),
  },
});
