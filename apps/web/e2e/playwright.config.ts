import { defineConfig, devices } from '@playwright/test';

/**
 * Exit-gate journeys (P00 T25) against a running stack: web :3000, api :4000, control-api :4100,
 * fakes :4200, Mailpit :8025 (docker compose + `pnpm dev`, or the CI e2e job). Workspaces live at
 * {slug}.localhost:3000, which Chromium resolves to loopback on its own.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 90_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled', caret: 'hide' },
  },
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1360, height: 860 },
    timezoneId: 'UTC',
    locale: 'en-GB',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1360, height: 860 },
        ...(process.env.PW_CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
          : {}),
      },
    },
  ],
});
