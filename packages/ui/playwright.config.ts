import { defineConfig } from '@playwright/test';

/**
 * Story checks (§9.13, §13.3): every story in the built Storybook, in light and dark, default and
 * compact density, plus RTL: axe must report no serious or critical violations (blocking), and a
 * screenshot is compared with the committed baseline (visual review; see the CI job).
 * PW_CHROMIUM_PATH points at a pre-installed Chromium where downloading browsers is not possible.
 */
export default defineConfig({
  testDir: 'stories-test',
  fullyParallel: true,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' } },
  use: {
    baseURL: 'http://127.0.0.1:6007',
    viewport: { width: 1280, height: 800 },
    launchOptions: process.env['PW_CHROMIUM_PATH']
      ? { executablePath: process.env['PW_CHROMIUM_PATH'] }
      : {},
  },
  webServer: {
    command: 'node scripts/serve-static.js',
    url: 'http://127.0.0.1:6007/index.json',
    reuseExistingServer: true,
  },
});
