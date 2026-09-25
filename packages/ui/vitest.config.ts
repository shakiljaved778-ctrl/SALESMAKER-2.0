import react from '@vitejs/plugin-react';
import { coverage } from '@sm/config/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['test/setup.ts'],
    coverage: coverage(),
  },
});
