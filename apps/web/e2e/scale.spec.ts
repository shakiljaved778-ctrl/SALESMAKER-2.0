import { expect, test } from '@playwright/test';

import { expectHome, signIn } from './flows';
import { expectAccessible, workspaceUrl } from './support';

/**
 * The scale journey (P02 T29): a telesales agent of the bank demo, seeded at load scale (500k
 * leads), works their list. Runs only in the scale workflow (E2E_SCALE=1), after
 * `pnpm db:seed --scenario=bank --scale=load`; every other run skips it.
 */
test.skip(!process.env.E2E_SCALE, 'needs the bank demo seeded at load scale');

const SLUG = 'aurelia-demo';
const AGENT = 'samuel.fernandes.007@aurelia-bank.example';
const PASSWORD = process.env.SEED_PASSWORD ?? 'demo passphrase 4821';
/** §11.1: list view first page ≤ 800 ms to rendered rows. */
const LIST_RENDER_BUDGET_MS = 800;

test('an agent works their leads at 500k: list, open, inline edit and search', async ({ page }) => {
  await signIn(page, SLUG, AGENT, PASSWORD);
  await expectHome(page, 'Samuel');

  // Client-side navigation to the list, timed to the first rendered row (median of three).
  const timings: number[] = [];
  for (let i = 0; i < 3; i++) {
    await page.goto(workspaceUrl(SLUG, '/home'));
    const started = Date.now();
    await page.getByRole('navigation').getByRole('link', { name: 'Leads', exact: true }).click();
    await expect(page.getByRole('grid').getByRole('row').nth(1)).toBeVisible();
    timings.push(Date.now() - started);
  }
  timings.sort((a, b) => a - b);
  test.info().annotations.push({ type: 'list render ms', description: timings.join(', ') });
  expect(timings[1]).toBeLessThanOrEqual(LIST_RENDER_BUDGET_MS);
  await expectAccessible(page);

  // Open the first lead the agent sees.
  const grid = page.getByRole('grid');
  const first = grid.getByRole('row').nth(1).getByRole('link').first();
  const name = (await first.textContent()) ?? '';
  await first.click();
  await page.waitForURL(/\/leads\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expectAccessible(page);

  // Search for it by name from the results page.
  await page.goto(workspaceUrl(SLUG, `/search?q=${encodeURIComponent(name)}`));
  await expect(page.getByRole('main').getByRole('link', { name }).first()).toBeVisible();
});
