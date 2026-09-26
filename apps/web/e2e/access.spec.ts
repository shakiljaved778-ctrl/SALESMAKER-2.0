import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, test, type Page } from '@playwright/test';

import { expectHome, signIn, signUpWithPassword, verifyFromEmail } from './flows';
import {
  expectAccessible,
  latestEmail,
  linkIn,
  PASSWORD,
  uniqueSlug,
  workspaceUrl,
} from './support';

const WORKER = fileURLToPath(new URL('../../worker', import.meta.url));

/**
 * What the API itself answers this user for the Setup user list, outside the UI: from inside the
 * page (same origin, its own refresh cookie), with a freshly issued access token.
 */
async function usersListStatus(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const refreshed = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const { accessToken } = (await refreshed.json()) as { accessToken: string };
    const res = await fetch('/api/v1/users', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return res.status;
  });
}

async function pick(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: new RegExp(option) }).click();
}

/**
 * P01 exit-gate journeys (T23): an admin invites a rep, who joins and finds Setup closed (hidden
 * in the UI, 403 from the API); the admin changes the rep's profile and access follows at once;
 * the audit chain verifies; and the Setup and settings screens pass axe in light and dark.
 */
test('invite → accept → constrained access; a profile change opens Setup; the chain verifies', async ({
  browser,
}) => {
  const slug = uniqueSlug('acc');
  const adminEmail = `owner@${slug}.test`;
  const repEmail = `rep@${slug}.test`;

  // The admin signs up and invites a rep with the Standard User profile.
  const admin = await (await browser.newContext()).newPage();
  await signUpWithPassword(admin, slug, adminEmail, 'Nadia Karim');
  await verifyFromEmail(admin, adminEmail);
  await signIn(admin, slug, adminEmail);
  await expectHome(admin, 'Nadia');
  // Personal settings load /v1/me in the browser, which carries the organisation's id.
  const meResponse = admin.waitForResponse((r) => r.url().endsWith('/api/v1/me'));
  await admin.goto(workspaceUrl(slug, '/settings/profile'));
  const { tenantId } = (await (await meResponse).json()) as { tenantId: string };

  await admin.goto(workspaceUrl(slug, '/setup/users'));
  await admin.getByRole('button', { name: 'Invite user' }).click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByLabel('Email').fill(repEmail);
  await dialog.getByLabel('Name').fill('Rami Haddad');
  await pick(admin, 'Profile', 'Standard User');
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(admin.getByText(`Invitation sent to ${repEmail}`, { exact: true })).toBeVisible();

  // The rep accepts from the email, chooses a password and lands signed in.
  const rep = await (await browser.newContext()).newPage();
  const { text } = await latestEmail(repEmail, /invited you to/);
  await rep.goto(linkIn(text, '/accept-invite'));
  await rep.getByLabel('Password').fill(PASSWORD);
  await rep.getByRole('button', { name: 'Join and sign in' }).click();
  await expectHome(rep, 'Rami');

  // Constrained: no Setup in the navigation, the page says so, and the API refuses.
  await expect(rep.getByRole('link', { name: 'Setup' })).toHaveCount(0);
  await rep.goto(workspaceUrl(slug, '/setup/users'));
  await expect(
    rep.getByRole('heading', { level: 3, name: 'Setup is for administrators' }),
  ).toBeVisible();
  await expectAccessible(rep);
  expect(await usersListStatus(rep)).toBe(403);

  // The admin makes the rep a System Administrator; the rep's access follows on the next load.
  await admin.goto(workspaceUrl(slug, '/setup/users'));
  await admin.getByRole('link', { name: 'Rami Haddad' }).click();
  await expect(admin.getByRole('heading', { name: 'Rami Haddad' })).toBeVisible();
  await pick(admin, 'Profile', 'System Administrator');
  await admin.getByRole('button', { name: 'Save changes' }).click();
  await expect(admin.getByText('Changes saved', { exact: true })).toBeVisible();

  await rep.goto(workspaceUrl(slug, '/home'));
  await expect(rep.getByRole('link', { name: 'Setup' })).toBeVisible();
  expect(await usersListStatus(rep)).toBe(200);
  await rep.goto(workspaceUrl(slug, '/setup/users'));
  await expect(rep.getByRole('heading', { name: 'Users' })).toBeVisible();

  // Every change above is in the audit trail, and the chain verifies end to end (the runbook's
  // on-demand check; the worker also runs it daily).
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--env-file-if-exists=../../.env', 'dist/verify-audit.js', tenantId],
    { cwd: WORKER },
  );
  expect(JSON.parse(stdout)).toMatchObject({ status: 'OK', pending: '0', problem: null });
  await admin.goto(workspaceUrl(slug, '/setup/audit-log'));
  await expect(admin.getByText(/Chain verified .*no problems\./)).toBeVisible();
  await admin.goto(workspaceUrl(slug, '/setup/setup-audit'));
  await expect(admin.getByText('Rami Haddad').first()).toBeVisible();
});

for (const theme of ['light', 'dark'] as const) {
  test(`Setup and personal settings pass axe (${theme})`, async ({ page }) => {
    const slug = uniqueSlug(`ax${theme[0] ?? ''}`);
    const email = `owner@${slug}.test`;
    await signUpWithPassword(page, slug, email, 'Lea Martin');
    await verifyFromEmail(page, email);
    await signIn(page, slug, email);
    await expectHome(page, 'Lea');
    // Chosen the way a user does, so it is saved to their preferences and follows them.
    await page.goto(workspaceUrl(slug, '/settings/display'));
    await page.getByRole('combobox', { name: 'Theme' }).click();
    await page.getByRole('option', { name: theme === 'dark' ? 'Dark' : 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    const screens: [string, string][] = [
      ['/setup/users', 'Users'],
      ['/setup/org-units', 'Org hierarchy'],
      ['/setup/profiles', 'Profiles'],
      ['/setup/sharing', 'Sharing settings'],
      ['/setup/audit-log', 'Audit log'],
      ['/settings/profile', 'Profile'],
      ['/settings/security', 'Security'],
    ];
    for (const [path, heading] of screens) {
      await page.goto(workspaceUrl(slug, path));
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expectAccessible(page);
    }
  });
}
