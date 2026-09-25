import { defineConfig } from 'vitest/config';

import { coverage } from './vitest/coverage.js';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    coverage: coverage({ include: ['eslint/**/*.js', 'vitest/**/*.js'] }),
  },
});
