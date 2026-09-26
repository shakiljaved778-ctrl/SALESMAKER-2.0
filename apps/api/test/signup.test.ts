import { withTenant, type CellPrisma } from '@sm/db';
import { buildFakesServer } from '@sm/testing';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PRISMA } from '../src/tokens.js';
import { startTestApi, type TestApi } from './support.js';

let fakes: FastifyInstance;
let api: TestApi;
let fakesBase = '';

beforeAll(async () => {
  const probe = await buildFakesServer({ baseUrl: 'http://127.0.0.1', providers: {} });
  const port = new URL(await probe.listen({ port: 0, host: '127.0.0.1' })).port;
  await probe.close();
  fakesBase = `http://127.0.0.1:${port}`;
  fakes = await buildFakesServer({
    baseUrl: fakesBase,
    providers: { google: { clientId: 'g-client', clientSecret: 'g-secret' } },
  });
  await fakes.listen({ port: Number(port), host: '127.0.0.1' });
  api = await startTestApi({
    OIDC_GOOGLE_ISSUER: `${fakesBase}/google`,
    OIDC_GOOGLE_CLIENT_ID: 'g-client',
    OIDC_GOOGLE_CLIENT_SECRET: 'g-secret',
    OIDC_ALLOW_INSECURE_HTTP: 'true',
    // Many sign-ups come from 127.0.0.1 here; the limit itself is tested separately below.
    SIGNUP_RATE_PER_HOUR: '1000',
  });
});

afterAll(async () => {
  await api.dispose();
  await fakes.close();
});

type Json = Record<string, unknown>;
const PASSWORD = 'a sturdy passphrase 4821';

function signupBody(slug: string, overrides: Json = {}): Json {
  return {
    orgName: `${slug} Studio`,
    slug,
    name: 'Amira Haddad',
    email: `owner@${slug}.test`,
    password: PASSWORD,
    currency: 'USD',
    timezone: 'Asia/Qatar',
    ...overrides,
  };
}

function signup(body: Json, key = `key-${String(body['slug'])}-${String(Math.random())}`) {
  return api.app.inject({
    method: 'POST',
    url: '/auth/signup',
    headers: { 'idempotency-key': key },
    payload: body,
  });
}

function tokenFromEmail(to: string): string {
  const token = /token=([A-Za-z0-9_%-]+)/.exec(api.email.lastTo(to)?.text ?? '')?.[1];
  if (!token) throw new Error(`no token emailed to ${to}`);
  return decodeURIComponent(token);
}

const post = (url: string, tenantId: string, payload: Json) =>
  api.app.inject({ method: 'POST', url, headers: { 'x-sm-tenant-id': tenantId }, payload });

describe('POST /auth/signup (§7.20a)', () => {
  it('creates a pending organisation and owner, and emails a verification link on the workspace domain', async () => {
    const res = await signup(signupBody('pixelcraft'));
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      tenantId: string;
      slug: string;
      status: string;
      verificationSentTo: string;
    }>();
    expect(body).toMatchObject({
      slug: 'pixelcraft',
      status: 'PENDING',
      verificationSentTo: 'owner@pixelcraft.test',
    });
    expect(api.controlPlane.statusOf(body.tenantId)).toBe('PENDING');
    expect(api.email.lastTo('owner@pixelcraft.test')?.text).toContain(
      'http://pixelcraft.localhost:3000/verify-email?token=',
    );

    const settings = await withTenant(
      api.app.get<symbol, CellPrisma>(PRISMA),
      { tenantId: body.tenantId },
      ({ prisma }) => prisma.tenantSettings.findUnique({ where: { tenantId: body.tenantId } }),
    );
    expect(settings).toMatchObject({
      name: 'pixelcraft Studio',
      region: 'eu-central-1',
      corporateCurrency: 'USD',
      defaultTimezone: 'Asia/Qatar',
    });
    expect(settings?.ownerUserId).toBeTruthy();

    // The built-in profiles exist, with their grants, and the owner is the administrator.
    const access = await withTenant(
      api.app.get<symbol, CellPrisma>(PRISMA),
      { tenantId: body.tenantId },
      async ({ prisma }) => ({
        profiles: await prisma.profile.findMany({
          select: { systemKey: true, name: true, permissionSet: { select: { kind: true } } },
          orderBy: { name: 'asc' },
        }),
        owner: await prisma.user.findUnique({
          where: { tenantId_id: { tenantId: body.tenantId, id: settings?.ownerUserId ?? '' } },
          select: { profile: { select: { systemKey: true } } },
        }),
        adminSystem: await prisma.systemPermission.count({
          where: { permissionSet: { profile: { systemKey: 'system_administrator' } } },
        }),
        readOnlyEdits: await prisma.fieldPermission.count({
          where: { canEdit: true, permissionSet: { profile: { systemKey: 'read_only' } } },
        }),
        owd: await prisma.orgWideDefault.findMany({ select: { object: true, sharingModel: true } }),
        visible: await prisma.userVisibilityClosure.findMany({ select: { ownerId: true } }),
      }),
    );
    expect(access.profiles).toEqual([
      { systemKey: 'read_only', name: 'Read Only', permissionSet: { kind: 'PROFILE' } },
      { systemKey: 'standard_user', name: 'Standard User', permissionSet: { kind: 'PROFILE' } },
      {
        systemKey: 'system_administrator',
        name: 'System Administrator',
        permissionSet: { kind: 'PROFILE' },
      },
    ]);
    expect(access.owner?.profile?.systemKey).toBe('system_administrator');
    expect(access.adminSystem).toBeGreaterThan(10);
    expect(access.readOnlyEdits).toBe(0);
    expect(access.owd).toHaveLength(10);
    expect(access.owd).toContainEqual({ object: 'opportunity', sharingModel: 'PRIVATE' });
    expect(access.visible).toEqual([{ ownerId: settings?.ownerUserId }]);

    const early = await post('/auth/login', body.tenantId, {
      email: 'owner@pixelcraft.test',
      password: PASSWORD,
    });
    expect(early.statusCode).toBe(403);
  });

  it('activates the tenant when the owner verifies, then lets them sign in', async () => {
    const { tenantId } = (await signup(signupBody('aurelia'))).json<{ tenantId: string }>();
    const verify = await post('/auth/verify-email', tenantId, {
      token: tokenFromEmail('owner@aurelia.test'),
    });
    expect(verify.statusCode).toBe(200);
    expect(api.controlPlane.statusOf(tenantId)).toBe('ACTIVE');
    const login = await post('/auth/login', tenantId, {
      email: 'owner@aurelia.test',
      password: PASSWORD,
    });
    expect(login.json()).toMatchObject({
      status: 'ok',
      user: { workspace: { slug: 'aurelia' }, emailVerified: true },
    });
  });

  it('keeps the verification link usable when the control plane is down at verification time', async () => {
    const { tenantId } = (await signup(signupBody('outage-co'))).json<{ tenantId: string }>();
    const token = tokenFromEmail('owner@outage-co.test');
    api.controlPlane.unavailable = true;
    const down = await post('/auth/verify-email', tenantId, { token });
    api.controlPlane.unavailable = false;
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ code: 'service_unavailable' });
    expect((await post('/auth/verify-email', tenantId, { token })).statusCode).toBe(200);
    expect(api.controlPlane.statusOf(tenantId)).toBe('ACTIVE');
  });

  it('replays a retried Idempotency-Key without creating or emailing twice, and refuses a taken slug', async () => {
    const first = await signup(signupBody('replay-co'), 'idem-replay-0001');
    const sent = api.email.outbox.length;
    const retry = await signup(signupBody('replay-co'), 'idem-replay-0001');
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(first.json());
    expect(api.email.outbox.length).toBe(sent);
    const taken = await signup(signupBody('replay-co', { email: 'someone@else.test' }));
    expect(taken.statusCode).toBe(409);
  });

  it('validates the organisation and password', async () => {
    const cases: [Json, string][] = [
      [signupBody('Bad Slug'), 'slug'],
      [signupBody('good-co', { currency: 'XXZ' }), 'currency'],
      [signupBody('good-co', { timezone: 'Mars/Olympus' }), 'timezone'],
      [signupBody('good-co', { password: 'short' }), 'password'],
      [signupBody('good-co', { password: 'password1234' }), 'password'],
    ];
    for (const [body, field] of cases) {
      const res = await signup(body);
      expect(res.statusCode, field).toBe(400);
      expect(
        res.json<{ errors: { field: string }[] }>().errors.map((e) => e.field),
        field,
      ).toContain(field);
    }
    const noKey = await api.app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: signupBody('nokey-co'),
    });
    expect(noKey.statusCode).toBe(400);
  });

  it('creates nothing when the control plane is unreachable', async () => {
    const before = api.controlPlane.tenants.size;
    api.controlPlane.unavailable = true;
    const res = await signup(signupBody('offline-co'));
    api.controlPlane.unavailable = false;
    expect(res.statusCode).toBe(503);
    expect(api.controlPlane.tenants.size).toBe(before);
  });

  it('releases the reservation if provisioning in the cell fails (compensation)', async () => {
    const tenantId = uuidv7();
    await api.seedTenant('squatter', tenantId); // provisioning will collide with this row
    api.controlPlane.nextTenantId = tenantId;
    const res = await signup(signupBody('collide-co'));
    expect(res.statusCode).toBe(500);
    expect(api.controlPlane.tenants.has(tenantId)).toBe(false);
  });

  it('rate-limits sign-ups per network', async () => {
    const limited = await startTestApi({ SIGNUP_RATE_PER_HOUR: '2' });
    try {
      const statuses = [];
      for (const slug of ['rate-a', 'rate-b', 'rate-c']) {
        statuses.push(
          (
            await limited.app.inject({
              method: 'POST',
              url: '/auth/signup',
              headers: { 'idempotency-key': `k-${slug}-0001` },
              payload: signupBody(slug),
            })
          ).statusCode,
        );
      }
      expect(statuses).toEqual([201, 201, 429]);
    } finally {
      await limited.dispose();
    }
  });
});

describe('POST /auth/signup/oidc/{provider}', () => {
  async function authorize(
    email: string,
    options: { unverified?: boolean; redirectUri?: string } = {},
  ) {
    const redirectUri = options.redirectUri ?? 'http://localhost:3000/signup/callback/google';
    const start = await api.app.inject({
      method: 'POST',
      url: '/auth/oidc/google/start',
      payload: { redirectUri },
    });
    const { authorizationUrl, state, nonce, codeVerifier } = start.json<{
      authorizationUrl: string;
      state: string;
      nonce: string;
      codeVerifier: string;
    }>();
    const url = new URL(authorizationUrl);
    url.searchParams.set('fake_email', email);
    url.searchParams.set('fake_name', 'Omar Khalil');
    if (options.unverified) url.searchParams.set('fake_unverified', '1');
    const res = await fetch(url, { redirect: 'manual' });
    return {
      callbackUrl: res.headers.get('location') ?? '',
      redirectUri,
      state,
      nonce,
      codeVerifier,
    };
  }

  const org = (slug: string) => ({
    orgName: `${slug} Co`,
    slug,
    currency: 'QAR',
    timezone: 'Asia/Qatar',
  });

  it('creates an active organisation with the verified identity as owner and signs in', async () => {
    const res = await api.app.inject({
      method: 'POST',
      url: '/auth/signup/oidc/google',
      headers: { 'idempotency-key': 'oidc-signup-0001' },
      payload: { ...(await authorize('omar@gulf.test')), ...org('gulf-trading') },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ tenantId: string; login: Json }>();
    expect(body.login).toMatchObject({
      status: 'ok',
      user: { email: 'omar@gulf.test', name: 'Omar Khalil', emailVerified: true },
    });
    expect(api.controlPlane.statusOf(body.tenantId)).toBe('ACTIVE');
  });

  it('refuses an unverified provider email and a workspace redirect URI', async () => {
    const unverified = await api.app.inject({
      method: 'POST',
      url: '/auth/signup/oidc/google',
      headers: { 'idempotency-key': 'oidc-signup-0002' },
      payload: {
        ...(await authorize('nope@gulf.test', { unverified: true })),
        ...org('unverified-co'),
      },
    });
    expect(unverified.statusCode).toBe(400);
    const wrongRedirect = await api.app.inject({
      method: 'POST',
      url: '/auth/signup/oidc/google',
      headers: { 'idempotency-key': 'oidc-signup-0003' },
      payload: {
        ...(await authorize('x@gulf.test', {
          redirectUri: 'http://alpha.localhost:3000/auth/callback/google',
        })),
        ...org('wrong-co'),
      },
    });
    expect(wrongRedirect.statusCode).toBe(400);
  });
});
