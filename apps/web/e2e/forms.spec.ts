import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

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

/** The signed-in API through the page's own BFF (workspace hosts resolve only in the browser). */
async function api(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
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

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

test('a hosted web form: validation, a lead, light and dark, and the embed', async ({
  page,
  browser,
}) => {
  trackToken(page);
  const slug = uniqueSlug('forms');
  const email = `owner@${slug}.test`;
  await signUpWithPassword(page, slug, email, 'Farah Owner');
  await verifyFromEmail(page, email);
  await signIn(page, slug, email);
  await expectHome(page, 'Farah');
  // A list page calls the API, which gives us the session's token.
  await page.goto(workspaceUrl(slug, '/leads'));
  await page.waitForLoadState('networkidle');

  const me = await api(page, 'GET', '/v1/me');
  const created = await api(page, 'POST', '/v1/setup/web-forms', {
    name: 'Contact us',
    status: 'ACTIVE',
    runAsUserId: me.body['id'],
    fields: [
      { field: 'first_name' },
      { field: 'last_name', required: true },
      { field: 'company', required: true },
      { field: 'email', required: true, label: 'Work email' },
    ],
    settings: {
      theme: 'light',
      thankYouMessage: 'Thanks for reaching out',
      consents: [{ key: 'contact', text: 'You may contact me about my request', required: true }],
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const formId = String(created.body['id']);
  const formUrl = `${BASE}/f/${slug}/${formId}`;

  // A visitor with no session, on the hosted page.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`${formUrl}?utm_source=e2e&utm_campaign=launch`);
  await expect(visitor.getByRole('heading', { name: 'Contact us' })).toBeVisible();
  await expectAccessible(visitor);

  await visitor.getByRole('button', { name: 'Submit' }).click();
  await expect(
    visitor.getByRole('alert').filter({ hasText: 'Some fields need attention.' }),
  ).toBeVisible();
  await expect(visitor.getByLabel('Last name')).toHaveAttribute('aria-invalid', 'true');

  await visitor.getByLabel('First name').fill('Omar');
  await visitor.getByLabel('Last name').fill('Haddad');
  await visitor.getByLabel('Company').fill('Haddad Trading');
  await visitor.getByLabel('Work email').fill('omar@mailinator.com');
  await visitor.getByRole('checkbox', { name: 'You may contact me about my request' }).check();
  await visitor.getByRole('button', { name: 'Submit' }).click();
  // The cell refuses disposable addresses; the error lands on the field.
  await expect(visitor.getByText('Use a permanent email address.')).toBeVisible();
  await visitor.getByLabel('Work email').fill(`omar@${slug}.test`);
  await visitor.getByRole('button', { name: 'Submit' }).click();
  await expect(visitor.getByRole('status')).toHaveText('Thanks for reaching out');

  const submissions = await api(page, 'GET', `/v1/setup/web-forms/${formId}/submissions`);
  expect(submissions.body['items']).toEqual([
    expect.objectContaining({
      status: 'CREATED',
      meta: expect.objectContaining({ utm_source: 'e2e', utm_campaign: 'launch' }),
    }),
  ]);

  // The form's own theme, whatever the visitor prefers.
  const changed = await api(page, 'PATCH', `/v1/setup/web-forms/${formId}`, {
    settings: { theme: 'dark', thankYouMessage: 'Thanks for reaching out' },
    version: created.body['version'],
  });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  await visitor.goto(formUrl);
  await expect(visitor.locator('[data-theme-scope="dark"]')).toBeVisible();
  await expectAccessible(visitor);

  // Embedded on another site: the snippet builds the iframe and passes the page's UTM. The site
  // is a loopback server: Chromium refuses public pages loading scripts from localhost (PNA).
  const site = createServer((_, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><html lang="en"><head><title>Customer</title></head><body>
      <main><h1>Customer site</h1>
      <div data-sm-form="${formUrl}" data-sm-title="Contact us"></div></main>
      <script src="${BASE}/forms/embed.js"></script></body></html>`);
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const { port } = site.address() as AddressInfo;
  const host = await (await browser.newContext()).newPage();
  await host.goto(`http://localhost:${String(port)}/landing?utm_source=partner`);
  const frame = host.frameLocator('iframe[title="Contact us"]');
  await expect(frame.getByRole('heading', { name: 'Contact us' })).toBeVisible();
  await expect(host.locator('iframe[title="Contact us"]')).toHaveAttribute(
    'src',
    /embed=1.*utm_source=partner.*landing=/,
  );
  // The form reported its height to the snippet.
  await expect
    .poll(async () =>
      host.locator('iframe').evaluate((el) => (el as HTMLIFrameElement).style.height),
    )
    .toMatch(/^\d+px$/);
  await expectAccessible(host);
  site.close();
});

test('a missing or inactive form is a plain 404', async ({ page }) => {
  const res = await page.goto(`${BASE}/f/no-such-workspace/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b`);
  expect(res?.status()).toBe(404);
});
