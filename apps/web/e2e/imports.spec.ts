import { expect, test, type Page } from '@playwright/test';

import { expectHome, signIn, signUpWithPassword, verifyFromEmail } from './flows';
import { expectAccessible, uniqueSlug, workspaceUrl } from './support';

/** The access token the app last sent, for API calls made from inside its page. */
const tokens = new WeakMap<Page, string>();
function trackToken(page: Page) {
  page.on('request', (request) => {
    const auth = request.headers()['authorization'];
    if (auth?.startsWith('Bearer ')) tokens.set(page, auth.slice(7));
  });
}

async function api(page: Page, method: string, path: string, body?: unknown) {
  const token = tokens.get(page);
  if (!token) throw new Error('the page has not called the API yet');
  return page.evaluate(
    async ({ m, p, t, b }) => {
      const res = await fetch(`/api${p}`, {
        method: m,
        headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
        ...(b === undefined ? {} : { body: JSON.stringify(b) }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
    { m: method, p: path, t: token, b: body },
  );
}

const CSV = [
  'First Name,Last Name,Company,Email,Annual Revenue',
  'Ada,Lovelace,Analytical Engines,ada@engines.example,"1,200"',
  'Alan,Turing,Bletchley,alan@bletchley.example,lots',
  'Grace,Hopper,Navy,grace@navy.example,900',
  'Known,Person,Existing Co,existing@known.example,10',
].join('\n');

test('import leads: upload, map, skip duplicates, test, run and undo', async ({ page }) => {
  test.setTimeout(150_000);
  trackToken(page);
  const slug = uniqueSlug('import');
  const email = `owner@${slug}.test`;
  await signUpWithPassword(page, slug, email, 'Ines Owner');
  await verifyFromEmail(page, email);
  await signIn(page, slug, email);
  await expectHome(page, 'Ines');
  await page.goto(workspaceUrl(slug, '/leads'));
  await page.waitForLoadState('networkidle');

  // A matching rule on email and one lead the file repeats.
  const rule = await api(page, 'POST', '/v1/setup/matching-rules', {
    object: 'lead',
    name: 'Same email',
    conditions: [{ field: 'email', method: 'email' }],
  });
  expect(rule.status, JSON.stringify(rule.body)).toBe(201);
  const known = await api(page, 'POST', '/v1/records/lead', {
    fields: { last_name: 'Person', company: 'Existing Co', email: 'existing@known.example' },
  });
  expect(known.status).toBe(201);

  await page.getByRole('button', { name: 'More list actions' }).click();
  await page.getByRole('menuitem', { name: 'Import' }).click();
  await expect(page.getByRole('heading', { name: 'Import Leads' })).toBeVisible();
  await expectAccessible(page);

  await page.locator('#import-file').setInputFiles({
    name: 'leads.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV),
  });
  await page.getByRole('button', { name: 'Upload' }).click();

  await expect(page.getByRole('heading', { name: 'Check the headers' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'ada@engines.example' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByRole('heading', { name: 'Match columns to fields' })).toBeVisible();
  // Headers matching fields are mapped already.
  await expect(page.getByRole('combobox', { name: 'Field for Email' })).toHaveText('Email');
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath('mapping.png'), fullPage: true });
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByRole('heading', { name: 'Duplicates and routing' })).toBeVisible();
  await page.getByRole('radio', { name: 'Skip the row' }).check();
  await page.getByRole('combobox', { name: 'Matching rule' }).click();
  await page.getByRole('option', { name: 'Same email' }).click();
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByRole('heading', { name: 'Review and test' })).toBeVisible();
  await page.getByRole('button', { name: 'Test the first 100 rows' }).click();
  await expect(
    page.getByText(/4 rows tested: 2 would be created, 0 updated, 1 skipped and 1 would fail/),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Start import' }).click();

  await expect(page.getByText('Completed', { exact: true })).toBeVisible({ timeout: 60_000 });
  const counts = page.getByRole('definition');
  await expect(counts.nth(0)).toHaveText('2');
  await expect(counts.nth(2)).toHaveText('1');
  await expect(counts.nth(3)).toHaveText('1');
  await page.getByRole('button', { name: 'Show failed rows' }).click();
  await expect(page.getByRole('cell', { name: 'annual_revenue: invalid_number' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('done.png'), fullPage: true });
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Undo import' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Undo import' }).click();
  await expect(page.getByText('Undone', { exact: true })).toBeVisible({ timeout: 60_000 });

  // The history lists it.
  await page.goto(workspaceUrl(slug, '/leads/import/history'));
  await expect(page.getByRole('link', { name: 'leads.csv' })).toBeVisible();
});
