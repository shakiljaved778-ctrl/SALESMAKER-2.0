import { expect, type Page } from '@playwright/test';

import { latestEmail, linkIn, PASSWORD, workspaceUrl } from './support';

/** Sign up on the apex with a password; returns once the "check your email" panel shows. */
export async function signUpWithPassword(page: Page, slug: string, email: string, name: string) {
  await page.goto('/sign-up');
  await page.getByLabel('Organisation name').fill(`E2E ${slug}`);
  await page.getByLabel('Workspace address').fill(slug);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

/** Open the verification link from Mailpit and confirm it worked. */
export async function verifyFromEmail(page: Page, email: string) {
  const { text } = await latestEmail(email, /Verify your email/);
  const link = linkIn(text, '/verify-email');
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Your email is verified.' })).toBeVisible();
}

export async function signIn(page: Page, slug: string, email: string, password = PASSWORD) {
  await page.goto(workspaceUrl(slug, '/sign-in'));
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function expectHome(page: Page, name: string) {
  await page.waitForURL('**/home');
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(name) })).toBeVisible();
}
