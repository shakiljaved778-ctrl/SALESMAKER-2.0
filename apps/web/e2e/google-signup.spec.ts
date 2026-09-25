import { expect, test } from '@playwright/test';

import { expectHome } from './flows';
import { expectAccessible, uniqueSlug, workspaceUrl } from './support';

/** Google sign-up through the fake IdP: the organisation is created active and signed in. */
test('create an organisation with Google and land in its shell', async ({ page }) => {
  const slug = uniqueSlug('ggl');
  const email = `founder@${slug}.test`;

  await page.goto('/sign-up');
  await page.getByLabel('Organisation name').fill(`Google ${slug}`);
  await page.getByLabel('Workspace address').fill(slug);
  await page.getByRole('button', { name: 'Continue with Google' }).click();

  // The fake provider asks who you are (it keeps no session, so it asks again on the workspace).
  for (let round = 0; round < 2; round++) {
    await expect(page.getByRole('heading', { name: 'Fake Google' })).toBeVisible();
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Name', { exact: true }).fill('Farah Khan');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
  }
  await expect(page).toHaveURL(workspaceUrl(slug, '/home'));
  await expectHome(page, 'Farah Khan');
  await expectAccessible(page);

  // No auto-join: a stranger with a Google account is refused.
  await page.context().clearCookies();
  await page.goto(workspaceUrl(slug, '/sign-in'));
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  // Wait for the provider's page: typing earlier would land in the sign-in form.
  await expect(page.getByRole('heading', { name: 'Fake Google' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(`stranger@${slug}-elsewhere.test`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL(/\/sso\/google\?failed=no_account$/);
  await expect(
    page.getByText("There's no account for this email in this workspace.", { exact: false }),
  ).toBeVisible();
  await expectAccessible(page);
});
