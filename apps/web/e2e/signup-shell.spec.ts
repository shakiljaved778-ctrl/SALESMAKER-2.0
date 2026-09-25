import { expect, test } from '@playwright/test';

import { expectHome, signIn, signUpWithPassword, verifyFromEmail } from './flows';
import { expectAccessible, uniqueSlug, workspaceUrl, expectScreenshot } from './support';

/**
 * Exit gate (P00): sign up → verify by email → sign in → the empty shell in light, dark and
 * compact, with no serious or critical axe findings anywhere on the way.
 */
test('sign up, verify, and reach the shell in every theme and density', async ({ page }) => {
  const slug = uniqueSlug('gate');
  const email = `owner@${slug}.test`;

  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-up$/);
  await expectAccessible(page);
  await signUpWithPassword(page, slug, email, 'Amira Haddad');
  await expectAccessible(page);
  await verifyFromEmail(page, email);

  await signIn(page, slug, email);
  await expectHome(page, 'Amira Haddad');
  await expectAccessible(page);

  const shellMasks = () => [
    page.getByRole('heading', { level: 1 }),
    page.getByRole('navigation', { name: 'Breadcrumb' }),
    page.locator('aside').getByText(`E2E ${slug}`),
    page.locator('aside span[aria-hidden="true"]').first(),
  ];
  for (const [theme, density] of [
    ['light', 'default'],
    ['dark', 'default'],
    ['light', 'compact'],
  ] as const) {
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitemradio', { name: theme === 'light' ? 'Light' : 'Dark' }).click();
    await page
      .getByRole('menuitemradio', { name: density === 'compact' ? 'Compact' : 'Default' })
      .click();
    await page.keyboard.press('Escape');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('html')).toHaveAttribute('data-density', density);
    await expectAccessible(page);
    await expectScreenshot(page, `shell-home-${theme}-${density}.png`, {
      mask: shellMasks(),
    });
  }

  // The choice is saved to the profile: a reload renders it without a flash.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');

  // ⌘K navigation and the shortcut sheet.
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.type('leads');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(workspaceUrl(slug, '/leads'));
  await expect(page.getByRole('heading', { name: 'Leads is on its way' })).toBeVisible();
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press('Escape');

  // Sign out ends the session: Home now sends you to sign in.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto(workspaceUrl(slug, '/home'));
  await expect(page).toHaveURL(/\/sign-in$/);
});
