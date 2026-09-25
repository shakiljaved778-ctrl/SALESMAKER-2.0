import { expect, test } from '@playwright/test';

import { expectHome, signIn, signUpWithPassword, verifyFromEmail } from './flows';
import {
  API,
  CONTROL_API,
  expectAccessible,
  PASSWORD,
  totp,
  uniqueSlug,
  workspaceUrl,
} from './support';

interface Tokens {
  tokens: { accessToken: string };
}

/** Sign in with a password and a TOTP code, then with a recovery code. */
test('two-step sign-in with an authenticator code and a recovery code', async ({ page }) => {
  const slug = uniqueSlug('mfa');
  const email = `owner@${slug}.test`;
  await signUpWithPassword(page, slug, email, 'Priya Nair');
  await verifyFromEmail(page, email);

  // Enrol through the API, as the settings screen will in P01.
  const resolved = (await (
    await fetch(`${CONTROL_API}/cp/v1/tenants/resolve?host=${new URL(workspaceUrl(slug)).host}`)
  ).json()) as { tenantId: string };
  const login = (await (
    await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sm-tenant-id': resolved.tenantId },
      body: JSON.stringify({ email, password: PASSWORD }),
    })
  ).json()) as Tokens;
  const auth = {
    authorization: `Bearer ${login.tokens.accessToken}`,
    'content-type': 'application/json',
  };
  const enrol = (await (
    await fetch(`${API}/auth/mfa/totp/enroll`, { method: 'POST', headers: auth, body: '{}' })
  ).json()) as { secret: string };
  const confirmed = (await (
    await fetch(`${API}/auth/mfa/totp/confirm`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ code: totp(enrol.secret) }),
    })
  ).json()) as { recoveryCodes: string[] };
  expect(confirmed.recoveryCodes).toHaveLength(10);

  await signIn(page, slug, email);
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel('6-digit code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText("That code didn't work", { exact: false })).toBeVisible();
  // The code just used to confirm is spent (replay protection); the next step's code is
  // inside the allowed drift window and has not been used.
  await page.getByLabel('6-digit code').fill(totp(enrol.secret, 1));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expectHome(page, 'Priya Nair');

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await signIn(page, slug, email);
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await page.getByLabel('Recovery code').fill(confirmed.recoveryCodes[0] ?? '');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expectHome(page, 'Priya Nair');
});
