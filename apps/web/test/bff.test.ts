import { describe, expect, it, vi } from 'vitest';

import { login, logout, mfaChallenge, refresh, type BffDeps } from '../src/server/bff';
import { readCookie } from '../src/server/http';
import { readPreferences } from '../src/lib/preferences';
import { clearRefreshCookie, setRefreshCookie } from '../src/server/session-cookie';
import { DirectoryUnavailableError, type Tenant } from '../src/server/tenant-directory';

const NOW = Date.parse('2026-09-25T12:00:00Z');
const TENANT: Tenant = {
  tenantId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  slug: 'acme',
  name: 'Acme Ltd',
  status: 'ACTIVE',
  cell: { id: 'eu-central-1', apiBaseUrl: 'http://cell-eu.test' },
};
const TOKENS = {
  accessToken: 'access.jwt.value',
  accessTokenExpiresAt: '2026-09-25T12:15:00.000Z',
  refreshToken: 'r'.repeat(43),
  refreshTokenExpiresAt: '2026-10-25T12:00:00.000Z',
};
const USER = {
  id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60',
  tenantId: TENANT.tenantId,
  email: 'amira@acme.test',
  name: 'Amira Haddad',
  emailVerified: true,
  locale: null,
  timezone: null,
  theme: 'system',
  density: 'default',
  mfaEnabled: false,
  workspace: { name: 'Acme Ltd', slug: 'acme' },
  permissions: ['run_reports'],
};
const PROBLEM_401 = {
  type: 'https://developers.salesmaker.app/problems/unauthenticated',
  title: 'Sign in to continue',
  status: 401,
  code: 'unauthenticated',
};

type CellCall = { url: string; tenantHeader: string | null; body: unknown };

function setup(
  cell: (path: string, body: unknown) => Response | Promise<Response>,
  overrides: Partial<BffDeps> = {},
) {
  const calls: CellCall[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const headers = new Headers(init?.headers);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, tenantHeader: headers.get('x-sm-tenant-id'), body });
    return cell(new URL(url).pathname, body);
  });
  const deps: BffDeps = {
    directory: {
      resolve: (host: string) => Promise.resolve(host === 'acme.localhost:3000' ? TENANT : null),
    },
    baseDomain: 'localhost:3000',
    scheme: 'http',
    fetch: fetchMock,
    now: () => NOW,
    ...overrides,
  };
  return { deps, calls };
}

function post(
  path: string,
  body: unknown,
  options: { host?: string; origin?: string; cookie?: string } = {},
) {
  const host = options.host ?? 'acme.localhost:3000';
  const origin = options.origin ?? `http://${host}`;
  const cookie = options.cookie ?? '';
  const headers: Record<string, string> = { host, 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  return new Request(`http://${host}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('BFF login', () => {
  it('signs in: the refresh token goes to an httpOnly cookie, the access token to the page', async () => {
    const { deps, calls } = setup(() =>
      Response.json({ status: 'ok', tokens: TOKENS, user: USER }),
    );
    const res = await login(post('/api/auth/login', { email: USER.email, password: 'pw' }), deps);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      status: 'ok',
      accessToken: TOKENS.accessToken,
      accessTokenExpiresAt: TOKENS.accessTokenExpiresAt,
      user: USER,
    });
    expect(JSON.stringify(body)).not.toContain(TOKENS.refreshToken);

    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^sm_rt=r{43}; /);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${String(30 * 24 * 3600)}`);
    expect(cookie).not.toContain('Domain=');
    expect(res.headers.get('cache-control')).toBe('no-store');

    // The cell comes from the directory, and the workspace is named by header.
    expect(calls).toEqual([
      {
        url: 'http://cell-eu.test/auth/login',
        tenantHeader: TENANT.tenantId,
        body: { email: USER.email, password: 'pw' },
      },
    ]);
  });

  it('passes an MFA challenge through without setting a cookie', async () => {
    const challenge = {
      status: 'mfa_required',
      mfaToken: 'm'.repeat(40),
      expiresAt: TOKENS.accessTokenExpiresAt,
    };
    const { deps } = setup(() => Response.json(challenge));
    const res = await login(post('/api/auth/login', { email: USER.email, password: 'pw' }), deps);
    expect(await res.json()).toEqual(challenge);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('completes MFA with a cookie', async () => {
    const { deps, calls } = setup(() =>
      Response.json({ status: 'ok', tokens: TOKENS, user: USER }),
    );
    const res = await mfaChallenge(
      post('/api/auth/mfa', { mfaToken: 'm'.repeat(40), code: '123456' }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/^sm_rt=/);
    expect(calls[0]?.url).toBe('http://cell-eu.test/auth/mfa/challenge');
  });

  it('relays cell problems with their status and Retry-After', async () => {
    const locked = { ...PROBLEM_401, status: 423, code: 'account_locked', title: 'Locked' };
    const { deps } = setup(() =>
      Response.json(locked, { status: 423, headers: { 'retry-after': '300' } }),
    );
    const res = await login(post('/api/auth/login', { email: USER.email, password: 'pw' }), deps);
    expect(res.status).toBe(423);
    expect(res.headers.get('retry-after')).toBe('300');
    expect(await res.json()).toEqual(locked);
  });

  it('validates input before calling the cell', async () => {
    const { deps, calls } = setup(() => Response.json({}));
    const res = await login(post('/api/auth/login', { email: 'not-an-email' }), deps);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; errors: { field: string }[] };
    expect(body.code).toBe('validation_failed');
    expect(body.errors.map((e) => e.field).sort()).toEqual(['email', 'password']);
    expect(calls).toHaveLength(0);
  });

  it('refuses cross-origin and origin-less posts (CSRF)', async () => {
    const { deps, calls } = setup(() => Response.json({}));
    for (const origin of ['http://evil.test', 'http://other.localhost:3000', '']) {
      const res = await login(
        post('/api/auth/login', { email: USER.email, password: 'pw' }, { origin }),
        deps,
      );
      expect(res.status).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it('answers 404 for the apex and unknown workspaces, never touching a cell', async () => {
    const { deps, calls } = setup(() => Response.json({}));
    for (const host of ['localhost:3000', 'ghost.localhost:3000']) {
      const res = await login(
        post('/api/auth/login', { email: USER.email, password: 'pw' }, { host }),
        deps,
      );
      expect(res.status).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  it('fails closed with 503 when the directory or the cell is unreachable, or the cell answers garbage', async () => {
    const down = setup(() => Response.json({}), {
      directory: { resolve: () => Promise.reject(new DirectoryUnavailableError()) },
    });
    expect(
      (await login(post('/api/auth/login', { email: USER.email, password: 'pw' }), down.deps))
        .status,
    ).toBe(503);

    const unreachable = setup(() => Promise.reject(new TypeError('fetch failed')));
    expect(
      (
        await login(
          post('/api/auth/login', { email: USER.email, password: 'pw' }),
          unreachable.deps,
        )
      ).status,
    ).toBe(503);

    const garbage = setup(() => Response.json({ status: 'ok' }));
    const res = await login(
      post('/api/auth/login', { email: USER.email, password: 'pw' }),
      garbage.deps,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('BFF refresh and logout', () => {
  const cookie = `other=1; sm_rt=${TOKENS.refreshToken}`;

  it('rotates the cookie and returns only the new access token', async () => {
    const rotated = { ...TOKENS, refreshToken: 's'.repeat(43) };
    const { deps, calls } = setup(() => Response.json(rotated));
    const res = await refresh(post('/api/auth/refresh', {}, { cookie }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok',
      accessToken: TOKENS.accessToken,
      accessTokenExpiresAt: TOKENS.accessTokenExpiresAt,
    });
    expect(res.headers.get('set-cookie')).toMatch(/^sm_rt=s{43}; /);
    expect(calls[0]?.body).toEqual({ refreshToken: TOKENS.refreshToken });
  });

  it('needs the cookie', async () => {
    const { deps, calls } = setup(() => Response.json({}));
    const res = await refresh(post('/api/auth/refresh', {}), deps);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('clears the cookie when the cell rejects the refresh token (expired, revoked or reused)', async () => {
    const { deps } = setup(() => Response.json(PROBLEM_401, { status: 401 }));
    const res = await refresh(post('/api/auth/refresh', {}, { cookie }), deps);
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBe(clearRefreshCookie('http'));
  });

  it('logs out upstream and always clears the cookie', async () => {
    const { deps, calls } = setup(() => new Response(null, { status: 204 }));
    const res = await logout(post('/api/auth/logout', {}, { cookie }), deps);
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(calls[0]?.url).toBe('http://cell-eu.test/auth/logout');

    const failing = setup(() => Promise.reject(new TypeError('down')));
    const again = await logout(post('/api/auth/logout', {}, { cookie }), failing.deps);
    expect(again.status).toBe(204);
    expect(again.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('refuses a cross-origin logout', async () => {
    const { deps } = setup(() => new Response(null, { status: 204 }));
    const res = await logout(
      post('/api/auth/logout', {}, { cookie, origin: 'http://evil.test' }),
      deps,
    );
    expect(res.status).toBe(403);
  });
});

describe('cookies and preferences', () => {
  it('uses a __Host- cookie with Secure over https', () => {
    const cookie = setRefreshCookie('https', 'tok', TOKENS.refreshTokenExpiresAt, NOW);
    expect(cookie).toMatch(/^__Host-sm_rt=tok; Path=\/; /);
    expect(cookie).toContain('Secure');
    expect(clearRefreshCookie('https')).toContain('Secure');
  });

  it('reads exactly the named cookie', () => {
    const req = new Request('http://x.test', { headers: { cookie: 'xsm_rt=a; sm_rt=b%3D; y=1' } });
    expect(readCookie(req, 'sm_rt')).toBe('b=');
    expect(readCookie(req, 'missing')).toBeUndefined();
  });

  it('falls back to defaults for missing or tampered preference cookies', () => {
    const values: Record<string, string> = {
      sm_theme: 'dark',
      sm_density: '"><script>',
      sm_locale: 'ar-XB',
    };
    expect(readPreferences((n) => values[n])).toEqual({
      theme: 'dark',
      density: 'default',
      locale: 'ar-XB',
    });
    expect(readPreferences(() => undefined)).toEqual({
      theme: 'system',
      density: 'default',
      locale: 'en',
    });
  });
});
