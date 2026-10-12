import { expect, test, type Page } from '@playwright/test';

import { expectHome, signIn, signUpWithPassword, verifyFromEmail } from './flows';
import { expectAccessible, uniqueSlug, workspaceUrl } from './support';

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

test('duplicates: rules in Setup, a Block, the panel, a merge and the review queue', async ({
  page,
}) => {
  test.setTimeout(150_000);
  trackToken(page);
  const slug = uniqueSlug('dupes');
  const email = `owner@${slug}.test`;
  await signUpWithPassword(page, slug, email, 'Dana Owner');
  await verifyFromEmail(page, email);
  await signIn(page, slug, email);
  await expectHome(page, 'Dana');

  // Setup → Matching & duplicate rules.
  await page.goto(workspaceUrl(slug, '/setup/duplicates'));
  await page.getByRole('button', { name: 'New matching rule' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Same email');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'Same email', exact: true })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('tab', { name: 'Duplicate rules' }).click();
  await page.getByRole('button', { name: 'New duplicate rule' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('No twins');
  await dialog.getByRole('combobox', { name: 'Matching rule' }).click();
  await page.getByRole('option', { name: 'Same email' }).click();
  await dialog.getByRole('radio', { name: 'Block the save' }).check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'No twins', exact: true })).toBeVisible();

  const original = await api(page, 'POST', '/v1/records/lead', {
    fields: { last_name: 'Original', company: 'Twin Co', email: 'twin@twins.example' },
  });
  expect(original.status).toBe(201);
  const originalId = String(original.body['id']);

  // The Block names the rule and links the match.
  await page.goto(workspaceUrl(slug, '/leads/new'));
  await page.getByLabel('Last name').fill('Copy');
  await page.getByLabel('Company').fill('Twin Co');
  await page.getByRole('textbox', { name: 'Email' }).fill('twin@twins.example');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByText('Not saved: the duplicate rule “No twins” found a matching record.'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Original' })).toBeVisible();

  // An Alert instead: the save goes through and the record page shows the panel.
  const rules = await api(page, 'GET', '/v1/setup/duplicate-rules');
  const rule = (rules.body['items'] as { id: string; version: number }[])[0];
  await api(page, 'PATCH', `/v1/setup/duplicate-rules/${rule?.id ?? ''}`, {
    action: 'ALERT',
    version: rule?.version,
  });
  const copy = await api(page, 'POST', '/v1/records/lead', {
    fields: { last_name: 'Copy', company: 'Twin Co', email: 'twin@twins.example', title: 'Buyer' },
  });
  expect(copy.status).toBe(201);
  await page.goto(workspaceUrl(slug, `/leads/${String(copy.body['id'])}`));
  await expect(page.getByText('This Lead may duplicate 1 record')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select Original for merging' }).check();
  await page.getByRole('button', { name: 'Merge 2 records' }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('radiogroup', { name: 'Record that stays' })).toBeVisible();
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Merge' }).click();
  await expect(page.getByText('2 records merged', { exact: true })).toBeVisible();
  const gone = await api(page, 'GET', `/v1/records/lead/${originalId}`);
  expect(gone.status).toBe(404);

  // A scan finds stored duplicates for the review queue.
  for (const n of ['One', 'Two'])
    await api(page, 'POST', '/v1/records/lead', {
      fields: { last_name: n, company: 'Pair Co', email: 'pair@pairs.example' },
    });
  await page.goto(workspaceUrl(slug, '/setup/duplicates'));
  await page.getByRole('tab', { name: 'Duplicate jobs' }).click();
  await page.getByRole('button', { name: 'Scan for duplicates' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Matching rule' }).click();
  await page.getByRole('option', { name: /Same email/ }).click();
  await dialog.getByRole('button', { name: 'Start scan' }).click();
  await expect
    .poll(
      async () => {
        const r = await api(page, 'GET', '/v1/duplicate-candidates?object=lead');
        return (r.body['items'] as unknown[]).length;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  await page.goto(workspaceUrl(slug, '/leads/duplicates'));
  await expect(page.getByRole('heading', { name: '2 records that look alike' })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Not duplicates' }).click();
  await expect(page.getByText('Nothing to review', { exact: true }).first()).toBeVisible();
});
