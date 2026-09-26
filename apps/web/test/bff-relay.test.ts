import { describe, expect, it, vi } from 'vitest';

import { acceptInvitation, relayToCell, type BffDeps, type CellMethod } from '../src/server/bff';
import type { Tenant } from '../src/server/tenant-directory';

const TENANT: Tenant = {
  tenantId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  slug: 'acme',
  name: 'Acme Ltd',
  status: 'ACTIVE',
  cell: { id: 'eu-central-1', apiBaseUrl: 'http://cell-eu.test' },
};
const HOST = 'acme.localhost:3000';

interface Seen {
  url: string;
  method: string;
  authorization: string | null;
  idempotencyKey: string | null;
  tenantHeader: string | null;
  body: unknown;
}

function setup(cell: (url: URL) => Response = () => Response.json({ ok: true })) {
  const seen: Seen[] = [];
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    seen.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      idempotencyKey: headers.get('idempotency-key'),
      tenantHeader: headers.get('x-sm-tenant-id'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return Promise.resolve(cell(url));
  });
  const deps: BffDeps = {
    directory: { resolve: (host) => Promise.resolve(host === HOST ? TENANT : null) },
    baseDomain: 'localhost:3000',
    scheme: 'http',
    fetch: fetchMock,
  };
  return { deps, seen };
}

function request(
  method: CellMethod,
  path: string,
  options: { body?: string; origin?: string | null; token?: string | null; host?: string } = {},
) {
  const host = options.host ?? HOST;
  const headers: Record<string, string> = { host };
  const origin = options.origin === undefined ? `http://${host}` : options.origin;
  if (origin) headers['origin'] = origin;
  const token = options.token === undefined ? 'access.jwt' : options.token;
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`http://${host}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

describe('BFF relay /api/v1/* → cell /v1/*', () => {
  it('relays a GET with its query string and the bearer token, to the directory’s cell', async () => {
    const { deps, seen } = setup(() => Response.json({ items: [1] }));
    const res = await relayToCell(
      request('GET', '/api/v1/users?q=ann&limit=5', { origin: null }),
      deps,
      'GET',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [1] });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(seen).toEqual([
      {
        url: 'http://cell-eu.test/v1/users?q=ann&limit=5',
        method: 'GET',
        authorization: 'Bearer access.jwt',
        idempotencyKey: null,
        tenantHeader: null,
        body: undefined,
      },
    ]);
  });

  it('relays writes with their JSON body and idempotency key', async () => {
    const { deps, seen } = setup(() => Response.json({ id: 'x' }, { status: 201 }));
    const req = request('POST', '/api/v1/invitations', { body: '{"email":"a@b.test"}' });
    req.headers.set('idempotency-key', 'k-1');
    const res = await relayToCell(req, deps, 'POST');
    expect(res.status).toBe(201);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      body: { email: 'a@b.test' },
      idempotencyKey: 'k-1',
    });
  });

  it('passes 204s through empty and relays problems as they are', async () => {
    const { deps } = setup((url) =>
      url.pathname.endsWith('/gone')
        ? new Response(null, { status: 204 })
        : Response.json(
            {
              type: 'https://developers.salesmaker.app/problems/forbidden',
              title: 'Forbidden',
              status: 403,
              code: 'forbidden',
            },
            { status: 403 },
          ),
    );
    const gone = await relayToCell(request('DELETE', '/api/v1/queues/gone'), deps, 'DELETE');
    expect(gone.status).toBe(204);
    expect(await gone.text()).toBe('');
    const denied = await relayToCell(request('GET', '/api/v1/users'), deps, 'GET');
    expect(denied.status).toBe(403);
    expect(denied.headers.get('content-type')).toBe('application/problem+json');
  });

  it('refuses cross-origin writes, missing tokens and non-/v1 paths', async () => {
    const { deps, seen } = setup();
    const evil = await relayToCell(
      request('PATCH', '/api/v1/users/1', { body: '{}', origin: 'http://evil.test' }),
      deps,
      'PATCH',
    );
    expect(evil.status).toBe(403);
    const crossRead = await relayToCell(
      request('GET', '/api/v1/users', { origin: 'http://evil.test' }),
      deps,
      'GET',
    );
    expect(crossRead.status).toBe(403);
    const anonymous = await relayToCell(
      request('GET', '/api/v1/users', { token: null }),
      deps,
      'GET',
    );
    expect(anonymous.status).toBe(401);
    for (const path of ['/api/auth/login', '/api/v1/../auth/login', '/api/v1/../../x'])
      expect((await relayToCell(request('GET', path), deps, 'GET')).status, path).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it('keeps dot segments inside /v1 (the URL parser resolves them first)', async () => {
    const { deps, seen } = setup();
    await relayToCell(request('GET', '/api/v1/a/%2e%2e/users'), deps, 'GET');
    expect(seen[0]?.url).toBe('http://cell-eu.test/v1/users');
  });

  it('refuses a body that is not JSON, unknown workspaces and an unreachable cell', async () => {
    const { deps } = setup();
    expect(
      (await relayToCell(request('POST', '/api/v1/groups', { body: '{nope' }), deps, 'POST'))
        .status,
    ).toBe(400);
    expect(
      (
        await relayToCell(
          request('GET', '/api/v1/users', { host: 'nope.localhost:3000' }),
          deps,
          'GET',
        )
      ).status,
    ).toBe(404);
    const down: BffDeps = { ...deps, fetch: () => Promise.reject(new Error('down')) };
    expect((await relayToCell(request('GET', '/api/v1/users'), down, 'GET')).status).toBe(503);
  });
});

describe('BFF invitation acceptance', () => {
  it('accepts with the workspace header and signs the new user in', async () => {
    const tokens = {
      accessToken: 'a',
      accessTokenExpiresAt: '2026-09-25T12:15:00.000Z',
      refreshToken: 'r'.repeat(43),
      refreshTokenExpiresAt: '2026-10-25T12:00:00.000Z',
    };
    const user = {
      id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60',
      tenantId: TENANT.tenantId,
      email: 'new@acme.test',
      name: 'New',
      emailVerified: true,
      locale: null,
      timezone: null,
      theme: 'system',
      density: 'default',
      mfaEnabled: false,
      workspace: { name: 'Acme Ltd', slug: 'acme' },
      permissions: [],
    };
    const { deps, seen } = setup(() => Response.json({ status: 'ok', tokens, user }));
    const body = JSON.stringify({ token: 't'.repeat(43), password: 'a sturdy passphrase 4821' });
    const res = await acceptInvitation(
      request('POST', '/api/auth/invitations/accept', { body, token: null }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/^sm_rt=r{43}; /);
    expect(seen[0]).toMatchObject({
      url: 'http://cell-eu.test/auth/invitations/accept',
      tenantHeader: TENANT.tenantId,
    });
    const invalid = await acceptInvitation(
      request('POST', '/api/auth/invitations/accept', { body: '{}', token: null }),
      deps,
    );
    expect(invalid.status).toBe(422);
  });
});
