import { describe, expect, it, vi } from 'vitest';

import type { BffDeps } from '../src/server/bff';
import { clientIp, loadPublicForm, submitPublicForm } from '../src/server/forms';
import { DirectoryUnavailableError, type Tenant } from '../src/server/tenant-directory';

const TENANT: Tenant = {
  tenantId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  slug: 'acme',
  name: 'Acme Ltd',
  status: 'ACTIVE',
  cell: { id: 'eu-central-1', apiBaseUrl: 'http://cell-eu.test' },
};
const FORM_ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60';
const FORM = {
  id: FORM_ID,
  name: 'Contact us',
  fields: [
    { name: 'email', label: 'Email', type: 'email', required: true, maxLength: 255, options: [] },
  ],
  theme: 'auto',
  buttonLabel: null,
  consents: [],
  turnstileSiteKey: null,
};

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function setup(
  cell: (url: URL) => Response = () => Response.json(FORM),
  tenants: Record<string, Tenant | Error> = { 'acme.localhost:3000': TENANT },
) {
  const seen: Seen[] = [];
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    seen.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return Promise.resolve(cell(url));
  });
  const deps: BffDeps = {
    directory: {
      resolve: (host) => {
        const hit = tenants[host];
        return hit instanceof Error ? Promise.reject(hit) : Promise.resolve(hit ?? null);
      },
    },
    baseDomain: 'localhost:3000',
    scheme: 'http',
    fetch: fetchMock,
  };
  return { deps, seen };
}

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost:3000/api/forms/acme/${FORM_ID}`, {
    method: 'POST',
    body,
    headers: { host: 'localhost:3000', origin: 'http://localhost:3000', ...headers },
  });

describe('hosted forms: loading', () => {
  it('resolves the workspace by slug and asks its cell for the form', async () => {
    const { deps, seen } = setup();
    const out = await loadPublicForm(deps, 'acme', FORM_ID, 'en-XA');
    expect(out).toMatchObject({ kind: 'ok', tenant: TENANT, form: { name: 'Contact us' } });
    expect(seen[0]).toMatchObject({
      method: 'GET',
      url: `http://cell-eu.test/v1/public/forms/${TENANT.tenantId}/${FORM_ID}?locale=en-XA`,
    });
  });

  it('is not found for bad paths, unknown or suspended workspaces and missing forms', async () => {
    const { deps, seen } = setup(() => Response.json({}, { status: 404 }), {
      'acme.localhost:3000': TENANT,
      'gone.localhost:3000': { ...TENANT, status: 'SUSPENDED' },
    });
    expect(await loadPublicForm(deps, 'Bad Slug', FORM_ID, 'en')).toEqual({ kind: 'not_found' });
    expect(await loadPublicForm(deps, 'acme', 'not-a-uuid', 'en')).toEqual({ kind: 'not_found' });
    expect(await loadPublicForm(deps, 'nobody', FORM_ID, 'en')).toEqual({ kind: 'not_found' });
    expect(await loadPublicForm(deps, 'gone', FORM_ID, 'en')).toEqual({ kind: 'not_found' });
    expect(seen).toHaveLength(0);
    expect(await loadPublicForm(deps, 'acme', FORM_ID, 'en')).toEqual({ kind: 'not_found' });
  });

  it('is unavailable, not missing, when the directory or the cell cannot answer', async () => {
    const down = setup(undefined, { 'acme.localhost:3000': new DirectoryUnavailableError() });
    expect(await loadPublicForm(down.deps, 'acme', FORM_ID, 'en')).toEqual({ kind: 'unavailable' });
    const broken = setup(() => Response.json({ nope: true }));
    expect(await loadPublicForm(broken.deps, 'acme', FORM_ID, 'en')).toEqual({
      kind: 'unavailable',
    });
  });
});

describe('hosted forms: submitting', () => {
  it('relays the submission with the visitor’s address and agent', async () => {
    const { deps, seen } = setup(() =>
      Response.json({ status: 'received', message: 'Thanks', redirectUrl: null }, { status: 202 }),
    );
    const res = await submitPublicForm(
      post(JSON.stringify({ fields: { email: 'a@b.test' } }), {
        'x-forwarded-for': '198.51.100.7, 203.0.113.9',
        'user-agent': 'Browser/1.0',
      }),
      deps,
      'acme',
      FORM_ID,
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'received', message: 'Thanks', redirectUrl: null });
    expect(seen[0]?.url).toBe(
      `http://cell-eu.test/v1/public/forms/${TENANT.tenantId}/${FORM_ID}/submissions`,
    );
    expect(seen[0]?.headers.get('x-forwarded-for')).toBe('203.0.113.9');
    expect(seen[0]?.headers.get('user-agent')).toBe('Browser/1.0');
    expect(seen[0]?.body).toEqual({ fields: { email: 'a@b.test' } });
  });

  it('relays the cell’s problems, with Retry-After', async () => {
    const { deps } = setup(
      () =>
        new Response(
          JSON.stringify({
            type: 'https://developers.salesmaker.app/problems/rate-limited',
            title: 'Too many',
            status: 429,
            code: 'rate_limited',
          }),
          { status: 429, headers: { 'retry-after': '120' } },
        ),
    );
    const res = await submitPublicForm(post('{}'), deps, 'acme', FORM_ID);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('120');
  });

  it('refuses other origins, bad bodies and unknown forms before calling the cell', async () => {
    const { deps, seen } = setup();
    expect(
      (await submitPublicForm(post('{}', { origin: 'https://evil.test' }), deps, 'acme', FORM_ID))
        .status,
    ).toBe(403);
    expect((await submitPublicForm(post('nope'), deps, 'acme', FORM_ID)).status).toBe(400);
    expect(
      (await submitPublicForm(post(`{"x":"${'a'.repeat(70_000)}"}`), deps, 'acme', FORM_ID)).status,
    ).toBe(400);
    expect((await submitPublicForm(post('{}'), deps, 'nobody', FORM_ID)).status).toBe(404);
    expect((await submitPublicForm(post('{}'), deps, 'acme', 'x')).status).toBe(404);
    expect(seen).toHaveLength(0);
    const down = setup(() => {
      throw new Error('offline');
    });
    expect((await submitPublicForm(post('{}'), down.deps, 'acme', FORM_ID)).status).toBe(503);
  });

  it('takes the last forwarded hop as the visitor', () => {
    const req = (h: Record<string, string>) => new Request('http://x.test', { headers: h });
    expect(clientIp(req({ 'x-forwarded-for': 'spoofed, 10.0.0.1 , 203.0.113.9' }))).toBe(
      '203.0.113.9',
    );
    expect(clientIp(req({ 'x-real-ip': '203.0.113.5' }))).toBe('203.0.113.5');
    expect(clientIp(req({}))).toBeNull();
  });
});
