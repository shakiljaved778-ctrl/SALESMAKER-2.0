import { expect, test } from '@playwright/test';

import {
  expectAccessible,
  preferDisplay,
  uniqueSlug,
  workspaceUrl,
  expectScreenshot,
} from './support';
import { signUpWithPassword } from './flows';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

/** Visual baselines for the T9 screens (§13.3), light and dark, and an RTL smoke test. */
for (const theme of ['light', 'dark'] as const) {
  test(`auth screens render and pass axe (${theme})`, async ({ page }) => {
    await preferDisplay(page, BASE, { theme });
    await page.goto('/sign-up');
    await expect(page.getByRole('heading', { name: 'Create your organisation' })).toBeVisible();
    await expectAccessible(page);
    await expectScreenshot(page, `sign-up-${theme}.png`, { fullPage: true });

    await page.goto('/find-workspace');
    await expectAccessible(page);
    await expectScreenshot(page, `find-workspace-${theme}.png`);
  });
}

test('a workspace sign-in page, forgot password and system pages', async ({ page }) => {
  const slug = uniqueSlug('scr');
  await signUpWithPassword(page, slug, `owner@${slug}.test`, 'Omar Aziz');
  await page.goto(workspaceUrl(slug, '/sign-in'));
  await expectAccessible(page);
  await expectScreenshot(page, 'sign-in-light.png', {
    mask: [page.getByRole('heading', { level: 1 })],
  });
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  await expectAccessible(page);

  await page.goto(workspaceUrl('no-such-workspace-e2e', '/'));
  await expect(page.getByRole('heading', { name: "We can't find that page" })).toBeVisible();
  await expectAccessible(page);
  await page.goto(workspaceUrl(slug, '/forbidden'));
  await expectAccessible(page);
  await page.goto(workspaceUrl(slug, '/maintenance'));
  await expectAccessible(page);
});

test('RTL smoke: layout mirrors and stays accessible', async ({ page }) => {
  await preferDisplay(page, BASE, { locale: 'ar-XB' });
  await page.goto('/sign-up');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  // The form panel sits on the inline start (left in RTL), the brand panel on the end.
  const form = await page.getByRole('main').boundingBox();
  expect(form?.x).toBeLessThan(200);
  await expectAccessible(page);
  await expectScreenshot(page, 'sign-up-rtl.png', { fullPage: true });
});
