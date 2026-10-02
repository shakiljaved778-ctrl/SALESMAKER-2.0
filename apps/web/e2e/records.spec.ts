import { expect, test, type Page } from '@playwright/test';

import { expectHome, signIn, signUpWithPassword, verifyFromEmail } from './flows';
import {
  expectAccessible,
  latestEmail,
  linkIn,
  PASSWORD,
  preferDisplay,
  uniqueSlug,
  workspaceUrl,
} from './support';

/** A new workspace with its owner signed in, on the home page. */
async function newWorkspace(page: Page, prefix: string, name: string) {
  const slug = uniqueSlug(prefix);
  const email = `owner@${slug}.test`;
  await signUpWithPassword(page, slug, email, name);
  await verifyFromEmail(page, email);
  await signIn(page, slug, email);
  await expectHome(page, name.split(' ')[0] ?? name);
  return { slug, email };
}

/** Invite a Standard User, who accepts from the email and lands signed in on `rep`. */
async function inviteRep(admin: Page, rep: Page, slug: string, name: string) {
  const email = `rep@${slug}.test`;
  await admin.goto(workspaceUrl(slug, '/setup/users'));
  await admin.getByRole('button', { name: 'Invite user' }).click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Name').fill(name);
  await admin.getByRole('combobox', { name: 'Profile' }).click();
  await admin.getByRole('option', { name: /Standard User/ }).click();
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(admin.getByText(`Invitation sent to ${email}`, { exact: true })).toBeVisible();
  const { text } = await latestEmail(email, /invited you to/);
  await rep.goto(linkIn(text, '/accept-invite'));
  await rep.getByLabel('Password').fill(PASSWORD);
  await rep.getByRole('button', { name: 'Join and sign in' }).click();
  await expectHome(rep, name.split(' ')[0] ?? name);
}

/** What the API answers this user for a path, outside the UI (same origin, fresh access token). */
async function apiGet(page: Page, path: string): Promise<{ status: number; body: unknown }> {
  return page.evaluate(async (p) => {
    const refreshed = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const { accessToken } = (await refreshed.json()) as { accessToken: string };
    const res = await fetch(`/api${p}`, { headers: { authorization: `Bearer ${accessToken}` } });
    return { status: res.status, body: (await res.json()) as unknown };
  }, path);
}

/** Fill the full record form and save it; lands on the record page. */
async function createLead(page: Page, slug: string, fields: Record<string, string>) {
  await page.goto(workspaceUrl(slug, '/leads/new'));
  // Required fields are named "Last name (Required)".
  for (const [label, value] of Object.entries(fields))
    await page
      .getByRole('textbox', { name: new RegExp(`^${label}( \\(Required\\))?$`) })
      .fill(value);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL(/\/leads\/[0-9a-f-]{36}$/);
}

/**
 * P02 exit-gate journeys (T29): records created, changed and converted through the UI, found by
 * search, and the record screens accessible in light and dark.
 */
test('create → edit → convert → search, accessible in light and dark', async ({ page }) => {
  const { slug } = await newWorkspace(page, 'rec', 'Lina Haddad');

  // An empty object home says so and offers to create.
  await page.goto(workspaceUrl(slug, '/leads'));
  await expect(page.getByRole('heading', { level: 1, name: 'Leads' })).toBeVisible();
  await expect(page.getByText('No leads yet')).toBeVisible();
  // Quick create from the list; the new row shows at once.
  await page.getByRole('main').getByRole('button', { name: 'New', exact: true }).first().click();
  const quick = page.getByRole('dialog', { name: 'New Lead' });
  await quick.getByLabel('Last name').fill('Saleh');
  await quick.getByLabel('Company').fill('Qamar Logistics');
  await expectAccessible(page);
  await quick.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saleh created')).toBeVisible();
  await expect(quick).toBeHidden();
  await page.getByRole('main').getByRole('link', { name: 'Saleh', exact: true }).click();
  await page.waitForURL(/\/leads\/[0-9a-f-]{36}$/);
  const leadUrl = page.url();
  await expect(page.getByRole('heading', { level: 1, name: 'Saleh' })).toBeVisible();

  // Edit on the full form; the record page shows the change.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.waitForURL('**/edit');
  await page.getByLabel('First name', { exact: true }).fill('Omar');
  await page.getByLabel('Title', { exact: true }).fill('Head of Procurement');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL(leadUrl);
  await expect(page.getByRole('heading', { level: 1, name: 'Omar Saleh' })).toBeVisible();
  await expect(page.getByText('Head of Procurement').first()).toBeVisible();

  // The record page is accessible in both themes.
  await expectAccessible(page);
  await preferDisplay(page, leadUrl, { theme: 'dark' });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectAccessible(page);
  await preferDisplay(page, leadUrl, { theme: 'light' });
  await page.reload();

  // Convert into an account, a contact and an opportunity.
  await page.getByRole('button', { name: 'Convert', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Convert Omar Saleh' });
  await expect(dialog).toBeVisible();
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Convert', exact: true }).click();
  await expect(page.getByText('Omar Saleh converted')).toBeVisible();

  // Search finds what the conversion created.
  await page.goto(workspaceUrl(slug, `/search?q=${encodeURIComponent('Qamar')}`));
  await expect(page.getByRole('heading', { level: 1, name: /Qamar/ })).toBeVisible();
  const results = page.getByRole('main');
  await expect(results.getByRole('link', { name: 'Qamar Logistics', exact: true })).toBeVisible();
  await expect(results.getByRole('link', { name: 'Omar Saleh' }).first()).toBeVisible();
  await expectAccessible(page);

  // The account exists with the contact related to it.
  await results.getByRole('link', { name: 'Qamar Logistics', exact: true }).click();
  await page.waitForURL(/\/accounts\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Qamar Logistics' })).toBeVisible();
  await page.getByRole('tab', { name: 'Related' }).click();
  await expect(page.getByRole('link', { name: 'Omar Saleh' })).toBeVisible();
  await expectAccessible(page);
});

test('private sharing, a field hidden by field-level security, list views and inline edit', async ({
  browser,
}) => {
  const admin = await (await browser.newContext()).newPage();
  const rep = await (await browser.newContext()).newPage();
  const { slug } = await newWorkspace(admin, 'shr', 'Nadia Karim');
  await inviteRep(admin, rep, slug, 'Rami Haddad');

  // Leads are private by default: people see their own and what is shared with them.
  await admin.goto(workspaceUrl(slug, '/setup/sharing'));
  await expect(admin.getByRole('combobox', { name: 'Leads: Default access' })).toHaveText(
    'Private',
  );

  // A custom field Standard Users may not read (field-level security, set in the wizard).
  await admin.goto(workspaceUrl(slug, '/setup/objects/lead'));
  await admin.getByRole('button', { name: 'New field' }).click();
  const wizard = admin.getByRole('dialog', { name: 'New field' });
  await wizard.getByRole('radio', { name: 'Text', exact: true }).click();
  await wizard.getByRole('button', { name: 'Continue' }).click();
  await wizard.getByLabel('Label').fill('Wallet size');
  await wizard.getByRole('button', { name: 'Continue' }).click();
  await wizard.getByRole('checkbox', { name: 'Standard User can read' }).click();
  await expect(wizard.getByRole('checkbox', { name: 'Standard User can edit' })).not.toBeChecked();
  await wizard.getByRole('button', { name: 'Continue' }).click();
  await wizard.getByRole('button', { name: 'Create field' }).click();
  await expect(wizard).toBeHidden();

  // The administrator's lead carries the field; the rep's own lead form doesn't offer it.
  await createLead(admin, slug, {
    'Last name': 'Rahman',
    Company: 'Admin Holdings',
    'Wallet size': 'Tier one',
  });
  const adminLead = admin.url();
  await expect(admin.getByText('Tier one').first()).toBeVisible();
  await rep.goto(workspaceUrl(slug, '/leads/new'));
  await expect(rep.getByRole('textbox', { name: /^Last name/ })).toBeVisible();
  await expect(rep.getByLabel('Wallet size')).toHaveCount(0);
  await createLead(rep, slug, { 'Last name': 'Nasser', Company: 'Rep Traders' });
  const repLead = rep.url();
  await expect(rep.getByText('Wallet size')).toHaveCount(0);

  // The rep's list shows only their lead; the hidden field is not a column or a choice.
  await rep.goto(workspaceUrl(slug, '/leads'));
  const grid = rep.getByRole('grid');
  await expect(grid.getByRole('link', { name: 'Nasser', exact: true })).toBeVisible();
  await expect(grid.getByRole('link', { name: 'Rahman', exact: true })).toHaveCount(0);
  await rep.getByRole('button', { name: 'Columns' }).click();
  const chooser = rep.getByRole('dialog');
  await expect(chooser.getByText('Company', { exact: true }).first()).toBeVisible();
  await expect(chooser.getByText('Wallet size')).toHaveCount(0);
  await rep.keyboard.press('Escape');

  // Inline edit from the keyboard: focus a cell, E edits, Enter saves.
  const row = grid.getByRole('row').filter({ hasText: 'Nasser' });
  await row.getByRole('gridcell', { name: 'Rep Traders' }).click();
  await rep.keyboard.press('e');
  const editor = grid.getByRole('textbox');
  await editor.fill('Rep Traders Group');
  await editor.press('Enter');
  await expect(rep.getByText('Saved', { exact: true })).toBeVisible();
  await rep.reload();
  await expect(grid.getByRole('gridcell', { name: 'Rep Traders Group' })).toBeVisible();

  // A saved view: sorted by company, private to the rep, and offered in the view picker.
  await rep.getByRole('button', { name: 'More list actions' }).click();
  await rep.getByRole('menuitem', { name: 'Save as new view' }).click();
  const save = rep.getByRole('dialog', { name: 'Save as a new list view' });
  await save.getByLabel('Name').fill('My traders');
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rep.getByText('View saved', { exact: true })).toBeVisible();
  await expect(rep.getByRole('combobox', { name: 'List view' })).toHaveText(/My traders/);
  await expectAccessible(rep);

  // The rep can't reach the administrator's lead: the page says it isn't there, the API 404s.
  const adminLeadId = adminLead.split('/').pop() ?? '';
  expect((await apiGet(rep, `/v1/records/lead/${adminLeadId}`)).status).toBe(404);
  await rep.goto(adminLead);
  await expect(
    rep.getByRole('heading', { name: /isn.t available|not found|doesn.t exist/i }),
  ).toBeVisible();
  await expect(rep.getByText('Admin Holdings')).toHaveCount(0);

  // Search finds the rep's own lead and not the private one.
  await rep.goto(workspaceUrl(slug, `/search?q=${encodeURIComponent('Holdings')}`));
  await expect(rep.getByRole('main').getByRole('link', { name: 'Rahman' })).toHaveCount(0);
  await rep.goto(workspaceUrl(slug, `/search?q=${encodeURIComponent('Traders')}`));
  await expect(rep.getByRole('main').getByRole('link', { name: 'Nasser' }).first()).toBeVisible();

  // The field stays hidden on the rep's record page, in the API and in dark mode.
  await preferDisplay(rep, repLead, { theme: 'dark' });
  await rep.goto(repLead);
  await expect(rep.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(rep.getByRole('heading', { level: 1, name: 'Nasser' })).toBeVisible();
  await expect(rep.getByText('Wallet size')).toHaveCount(0);
  await expectAccessible(rep);
  const own = await apiGet(rep, `/v1/records/lead/${repLead.split('/').pop() ?? ''}`);
  expect(own.status).toBe(200);
  expect(own.body).toHaveProperty('last_name', 'Nasser');
  expect(own.body).not.toHaveProperty('wallet_size__c');
  const theirs = await apiGet(admin, `/v1/records/lead/${adminLeadId}`);
  expect(theirs.body).toHaveProperty('wallet_size__c', 'Tier one');
});
