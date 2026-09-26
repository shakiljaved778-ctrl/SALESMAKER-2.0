import { describe, expect, it, vi } from 'vitest';

import { findWorkspaces, signup, type ApexDeps } from '../src/server/apex';
import { forgotPassword, refresh, resetPassword, verifyEmail } from '../src/server/bff';
import type { Cell } from '../src/server/control-plane';
import { completeSignIn, completeSignup, startSignIn, startSignup } from '../src/server/oidc';
import type { Tenant } from '../src/server/tenant-directory';

const TENANT: Tenant = {
  tenantId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  slug: 'acme',
  name: 'Acme Ltd',
  status: 'ACTIVE',
  cell: { id: 'eu-central-1', apiBaseUrl: 'http://cell-eu.test' },
};
const CELLS: Cell[] = [
  {
    id: 'eu-central-1',
    region: 'eu-central-1',
    label: 'Europe (Frankfurt)',
    apiBaseUrl: 'http://cell-eu.test',
    signupOpen: true,
  },
  {
    id: 'me-central-1',
    region: 'me-central-1',
    label: 'UAE',
    apiBaseUrl: 'http://cell-me.test',
    signupOpen: false,
  },
];
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
  title: null,
  phone: null,
  emailVerified: true,
  locale: null,
  timezone: null,
  theme: 'system',
  density: 'default',
  mfaEnabled: false,
  workspace: { name: 'Acme Ltd', slug: 'acme' },
  permissions: [],
};
const START = {
  authorizationUrl: 'http://idp.test/authorize?x=1',
  state: 's'.repeat(24),
  nonce: 'n'.repeat(24),
  codeVerifier: 'v'.repeat(43),
};
const problem = (status: number, code: string, errors?: unknown[]) =>
  Response.json(
    {
      type: 'https://developers.salesmaker.app/problems/x',
      title: 'x',
      status,
      code,
      ...(errors ? { errors } : {}),
    },
    { status },
  );

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function setup(cell: (url: URL, call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return cell(new URL(url), call);
  });
  const findWorkspacesMock = vi.fn(() => Promise.resolve(true));
  const deps: ApexDeps = {
    directory: {
      resolve: (host) => Promise.resolve(host === 'acme.localhost:3000' ? TENANT : null),
    },
    controlPlane: { listCells: () => Promise.resolve(CELLS), findWorkspaces: findWorkspacesMock },
    baseDomain: 'localhost:3000',
    scheme: 'http',
    fetch: fetchMock,
    now: () => Date.parse('2026-09-25T12:00:00Z'),
  };
  return { deps, calls, findWorkspacesMock };
}

function request(
  method: 'GET' | 'POST',
  path: string,
  opts: { host?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
) {
  const host = opts.host ?? 'acme.localhost:3000';
  const headers: Record<string, string> = { host, origin: `http://${host}`, ...opts.headers };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`http://${host}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
}

/** Cookie values a response sets, by name. */
function cookiesOf(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of response.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const eq = pair?.indexOf('=') ?? -1;
    if (pair && eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

const SIGNUP = {
  orgName: 'Pixelcraft Studio',
  slug: 'pixelcraft',
  currency: 'USD',
  timezone: 'Asia/Dubai',
  name: 'Amira Haddad',
  email: 'amira@pixelcraft.test',
  password: 'correct horse battery staple',
  cellId: 'eu-central-1',
};

describe('sign-up (apex)', () => {
  it('creates the organisation in the chosen cell, forwarding the Idempotency-Key', async () => {
    const created = {
      tenantId: TENANT.tenantId,
      slug: 'pixelcraft',
      status: 'PENDING',
      verificationSentTo: SIGNUP.email,
    };
    const { deps, calls } = setup(() => Response.json(created, { status: 201 }));
    const res = await signup(
      request('POST', '/api/signup', {
        host: 'localhost:3000',
        body: SIGNUP,
        headers: { 'idempotency-key': 'key-12345678' },
      }),
      deps,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(created);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://cell-eu.test/auth/signup');
    expect(calls[0]?.headers.get('idempotency-key')).toBe('key-12345678');
    expect(calls[0]?.body).not.toHaveProperty('cellId');
  });

  it('requires an Idempotency-Key, an open region, and the apex host', async () => {
    const { deps, calls } = setup(() => Response.json({}, { status: 201 }));
    const noKey = await signup(
      request('POST', '/api/signup', { host: 'localhost:3000', body: SIGNUP }),
      deps,
    );
    expect(noKey.status).toBe(400);
    const closed = await signup(
      request('POST', '/api/signup', {
        host: 'localhost:3000',
        body: { ...SIGNUP, cellId: 'me-central-1' },
        headers: { 'idempotency-key': 'key-12345678' },
      }),
      deps,
    );
    expect(closed.status).toBe(422);
    const onWorkspace = await signup(
      request('POST', '/api/signup', {
        body: SIGNUP,
        headers: { 'idempotency-key': 'key-12345678' },
      }),
      deps,
    );
    expect(onWorkspace.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('relays a taken address (409) and breached-password errors', async () => {
    const { deps } = setup(() => problem(409, 'conflict'));
    const res = await signup(
      request('POST', '/api/signup', {
        host: 'localhost:3000',
        body: SIGNUP,
        headers: { 'idempotency-key': 'key-12345678' },
      }),
      deps,
    );
    expect(res.status).toBe(409);
  });

  it('asks the control plane to email the workspace list, always answering the same way', async () => {
    const { deps, findWorkspacesMock } = setup(() => Response.json({}));
    const res = await findWorkspaces(
      request('POST', '/api/workspaces/find', {
        host: 'localhost:3000',
        body: { email: 'amira@acme.test' },
        cookie: 'sm_locale=en-XA',
      }),
      deps,
    );
    expect(res.status).toBe(202);
    expect(findWorkspacesMock).toHaveBeenCalledWith('amira@acme.test', 'en-XA');
  });
});

describe('tenant relays and refresh', () => {
  it('relays verify, forgot and reset to the tenant cell and hides the upstream body', async () => {
    const { deps, calls } = setup((url) =>
      url.pathname === '/auth/verify-email'
        ? Response.json({ verified: true })
        : new Response(null, { status: 202 }),
    );
    for (const [handler, path, body] of [
      [verifyEmail, '/api/auth/verify-email', { token: 't'.repeat(30) }],
      [forgotPassword, '/api/auth/password/forgot', { email: 'amira@acme.test' }],
      [
        resetPassword,
        '/api/auth/password/reset',
        { token: 't'.repeat(30), newPassword: 'n'.repeat(14) },
      ],
    ] as const) {
      const res = await handler(request('POST', path, { body }), deps);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    }
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/auth/verify-email',
      '/auth/password/forgot',
      '/auth/password/reset',
    ]);
    expect(calls.every((c) => c.headers.get('x-sm-tenant-id') === TENANT.tenantId)).toBe(true);
  });

  it('relays an expired token problem with its field errors', async () => {
    const { deps } = setup(() =>
      problem(400, 'validation_failed', [{ field: 'token', code: 'invalid_token', message: 'x' }]),
    );
    const res = await verifyEmail(
      request('POST', '/api/auth/verify-email', { body: { token: 't'.repeat(30) } }),
      deps,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors: { code: string }[] }).errors[0]?.code).toBe(
      'invalid_token',
    );
  });

  it('returns the user with a refreshed session, loading /v1/me with the new access token', async () => {
    const { deps, calls } = setup((url) =>
      url.pathname === '/v1/me' ? Response.json(USER) : Response.json(TOKENS),
    );
    const res = await refresh(
      request('POST', '/api/auth/refresh', { cookie: `sm_rt=${'o'.repeat(43)}` }),
      deps,
    );
    expect(((await res.json()) as { user: unknown }).user).toEqual(USER);
    const me = calls.find((c) => c.url.endsWith('/v1/me'));
    expect(me?.method).toBe('GET');
    expect(me?.headers.get('authorization')).toBe(`Bearer ${TOKENS.accessToken}`);
  });

  it('still rotates the cookie when the profile call fails', async () => {
    const { deps } = setup((url) =>
      url.pathname === '/v1/me' ? problem(500, 'internal_error') : Response.json(TOKENS),
    );
    const res = await refresh(
      request('POST', '/api/auth/refresh', { cookie: `sm_rt=${'o'.repeat(43)}` }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(cookiesOf(res).sm_rt).toBe(TOKENS.refreshToken);
  });
});

describe('Google/Microsoft sign-in (workspace)', () => {
  it('starts at the tenant cell with our callback and keeps PKCE values in an httpOnly cookie', async () => {
    const { deps, calls } = setup(() => Response.json(START));
    const res = await startSignIn(request('GET', '/auth/start/google'), deps, 'google');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(START.authorizationUrl);
    expect(calls[0]?.url).toBe('http://cell-eu.test/auth/oidc/google/start');
    expect(calls[0]?.body).toEqual({
      redirectUri: 'http://acme.localhost:3000/auth/callback/google',
    });
    const cookie = res.headers.getSetCookie()[0] ?? '';
    expect(cookie).toMatch(/^sm_oidc=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=600');
    expect(res.headers.get('location')).not.toContain(START.codeVerifier);
  });

  async function stateCookie(deps: ApexDeps) {
    const res = await startSignIn(request('GET', '/auth/start/google'), deps, 'google');
    return `sm_oidc=${cookiesOf(res).sm_oidc ?? ''}`;
  }

  it('completes with the saved values, sets the session cookie and clears the state', async () => {
    const { deps, calls } = setup((url) =>
      url.pathname.endsWith('/start')
        ? Response.json(START)
        : Response.json({ status: 'ok', tokens: TOKENS, user: USER }),
    );
    const cookie = await stateCookie(deps);
    const res = await completeSignIn(
      request('GET', '/auth/callback/google?code=abc&state=xyz', { cookie }),
      deps,
      'google',
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(cookiesOf(res)).toEqual({ sm_oidc: '', sm_rt: TOKENS.refreshToken });
    const callback = calls.at(-1);
    expect(callback?.url).toBe('http://cell-eu.test/auth/oidc/google/callback');
    expect(callback?.body).toEqual({
      callbackUrl: 'http://acme.localhost:3000/auth/callback/google?code=abc&state=xyz',
      redirectUri: 'http://acme.localhost:3000/auth/callback/google',
      state: START.state,
      nonce: START.nonce,
      codeVerifier: START.codeVerifier,
    });
  });

  it('hands an MFA challenge to the sign-in page in the fragment', async () => {
    const { deps } = setup((url) =>
      url.pathname.endsWith('/start')
        ? Response.json(START)
        : Response.json({
            status: 'mfa_required',
            mfaToken: 'm'.repeat(40),
            expiresAt: TOKENS.accessTokenExpiresAt,
          }),
    );
    const res = await completeSignIn(
      request('GET', '/auth/callback/google?code=a', { cookie: await stateCookie(deps) }),
      deps,
      'google',
    );
    expect(res.headers.get('location')).toBe(`/sign-in#mfa=${'m'.repeat(40)}`);
    expect(cookiesOf(res).sm_rt).toBeUndefined();
  });

  it('fails safely without the state cookie, for the wrong provider, or with no account', async () => {
    const { deps, calls } = setup((url) =>
      url.pathname.endsWith('/start') ? Response.json(START) : problem(403, 'forbidden'),
    );
    const missing = await completeSignIn(
      request('GET', '/auth/callback/google?code=a'),
      deps,
      'google',
    );
    expect(missing.headers.get('location')).toBe('/sso/google?failed=1');
    const cookie = await stateCookie(deps);
    const wrong = await completeSignIn(
      request('GET', '/auth/callback/microsoft?code=a', { cookie }),
      deps,
      'microsoft',
    );
    expect(wrong.headers.get('location')).toBe('/sso/microsoft?failed=1');
    expect(calls.filter((c) => c.url.endsWith('/callback'))).toHaveLength(0);
    const noAccount = await completeSignIn(
      request('GET', '/auth/callback/google?code=a', { cookie }),
      deps,
      'google',
    );
    expect(noAccount.headers.get('location')).toBe('/sso/google?failed=no_account');
    const tampered = await completeSignIn(
      request('GET', '/auth/callback/google', { cookie: 'sm_oidc=bm90LWpzb24' }),
      deps,
      'google',
    );
    expect(tampered.headers.get('location')).toBe('/sso/google?failed=1');
  });

  it('rejects unknown providers', async () => {
    const { deps } = setup(() => Response.json(START));
    expect((await startSignIn(request('GET', '/auth/start/github'), deps, 'github')).status).toBe(
      404,
    );
  });
});

describe('Google/Microsoft sign-up (apex)', () => {
  const ORG = {
    orgName: 'Pixelcraft Studio',
    slug: 'pixelcraft',
    currency: 'USD',
    timezone: 'UTC',
    cellId: 'eu-central-1',
    provider: 'google',
  };

  async function started(deps: ApexDeps) {
    const res = await startSignup(
      request('POST', '/api/signup/oidc', {
        host: 'localhost:3000',
        body: ORG,
        headers: { 'idempotency-key': 'key-12345678' },
      }),
      deps,
    );
    return { res, cookie: `sm_oidc=${cookiesOf(res).sm_oidc ?? ''}` };
  }

  it('starts at the chosen cell with the apex callback', async () => {
    const { deps, calls } = setup(() => Response.json(START));
    const { res } = await started(deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorizationUrl: START.authorizationUrl });
    expect(calls[0]?.body).toEqual({ redirectUri: 'http://localhost:3000/signup/callback/google' });
  });

  it('creates the organisation, revokes the apex session, and continues on the workspace host', async () => {
    const created = {
      tenantId: TENANT.tenantId,
      slug: 'pixelcraft',
      login: { status: 'ok', tokens: TOKENS, user: USER },
    };
    const { deps, calls } = setup((url) => {
      if (url.pathname.endsWith('/start')) return Response.json(START);
      if (url.pathname === '/auth/logout') return new Response(null, { status: 204 });
      return Response.json(created, { status: 201 });
    });
    const { cookie } = await started(deps);
    const res = await completeSignup(
      request('GET', '/signup/callback/google?code=a', { host: 'localhost:3000', cookie }),
      deps,
      'google',
    );
    expect(res.headers.get('location')).toBe('http://pixelcraft.localhost:3000/sso/google');
    expect(cookiesOf(res)).toEqual({ sm_oidc: '' });
    const create = calls.find((c) => c.url.endsWith('/auth/signup/oidc/google'));
    expect(create?.headers.get('idempotency-key')).toBe('key-12345678');
    expect(create?.body).toMatchObject({
      orgName: 'Pixelcraft Studio',
      slug: 'pixelcraft',
      redirectUri: 'http://localhost:3000/signup/callback/google',
    });
    const logout = calls.find((c) => c.url.endsWith('/auth/logout'));
    expect(logout?.body).toEqual({ refreshToken: TOKENS.refreshToken });
    expect(logout?.headers.get('x-sm-tenant-id')).toBe(TENANT.tenantId);
  });

  it('sends a taken address back to the form', async () => {
    const { deps } = setup((url) =>
      url.pathname.endsWith('/start') ? Response.json(START) : problem(409, 'conflict'),
    );
    const { cookie } = await started(deps);
    const res = await completeSignup(
      request('GET', '/signup/callback/google?code=a', { host: 'localhost:3000', cookie }),
      deps,
      'google',
    );
    expect(res.headers.get('location')).toBe('/sign-up?error=slug_taken&provider=google');
  });

  it('will not reuse a workspace sign-in state for sign-up', async () => {
    const { deps } = setup(() => Response.json(START));
    const signIn = await startSignIn(request('GET', '/auth/start/google'), deps, 'google');
    const res = await completeSignup(
      request('GET', '/signup/callback/google?code=a', {
        host: 'localhost:3000',
        cookie: `sm_oidc=${cookiesOf(signIn).sm_oidc ?? ''}`,
      }),
      deps,
      'google',
    );
    expect(res.headers.get('location')).toBe('/sign-up?error=sso_failed&provider=google');
  });
});
