import { visibility, withTenant, type CellPrisma } from '@sm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { provisionDefaultProfiles } from '../src/permissions/default-profiles.js';
import { PRISMA } from '../src/tokens.js';
import { startTestApi, type TestApi } from './support.js';

const PASSWORD = 'a sturdy passphrase 4821';
let api: TestApi;
let prisma: CellPrisma;
let tenantId = '';
let otherTenant = '';
const id: Record<string, string> = {};
const get = (n: string) => {
  const v = id[n];
  if (!v) throw new Error(`no fixture ${n}`);
  return v;
};
type Json = Record<string, unknown>;

async function call(
  user: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: Json,
  tenant = tenantId,
) {
  return api.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await api.tokenFor(tenant, get(user))}` },
    ...(payload ? { payload } : {}),
  });
}
const accept = (token: string, password = PASSWORD, tenant = tenantId) =>
  api.app.inject({
    method: 'POST',
    url: '/auth/invitations/accept',
    headers: { 'x-sm-tenant-id': tenant },
    payload: { token, password },
  });
function inviteToken(email: string): string {
  const text = api.email.lastTo(email)?.text ?? '';
  const token = /accept-invite\?token=([A-Za-z0-9_%-]+)/.exec(text)?.[1];
  if (!token) throw new Error(`no invitation emailed to ${email}`);
  return decodeURIComponent(token);
}
const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2], tenant = tenantId) =>
  withTenant(prisma, { tenantId: tenant }, fn);

beforeAll(async () => {
  api = await startTestApi();
  prisma = api.app.get<symbol, CellPrisma>(PRISMA);
  tenantId = await api.seedTenant('users');
  otherTenant = await api.seedTenant('users-other');
  for (const [name, tenant] of [
    ['admin', tenantId],
    ['rep', tenantId],
    ['boss', tenantId],
    ['otherAdmin', otherTenant],
  ] as const)
    id[name] = await api.seedUser(tenant, `${name.toLowerCase()}@users.test`, PASSWORD);
  for (const [tenant, admin] of [
    [tenantId, 'admin'],
    [otherTenant, 'otherAdmin'],
  ] as const) {
    await inTenant(async (tx) => {
      const profiles = await provisionDefaultProfiles(tx, tenant, 'en');
      id[`${tenant}:std`] = profiles.standard_user;
      id[`${tenant}:ro`] = profiles.read_only;
      await tx.prisma.user.update({
        where: { tenantId_id: { tenantId: tenant, id: get(admin) } },
        data: { profileId: profiles.system_administrator },
      });
      if (tenant === tenantId) {
        await tx.prisma.tenantSettings.update({
          where: { tenantId },
          data: { ownerUserId: get('admin') },
        });
        await tx.prisma.user.updateMany({
          where: { id: { in: [get('rep'), get('boss')] } },
          data: { profileId: profiles.standard_user },
        });
        id['top'] = (await tx.prisma.orgUnit.create({ data: { tenantId, name: 'Top' } })).id;
        id['field'] = (
          await tx.prisma.orgUnit.create({
            data: { tenantId, name: 'Field', parentId: get('top') },
          })
        ).id;
        await tx.prisma.user.update({
          where: { tenantId_id: { tenantId, id: get('boss') } },
          data: { orgUnitId: get('top') },
        });
        const set = await tx.prisma.permissionSet.create({ data: { tenantId, name: 'Exporters' } });
        await tx.prisma.systemPermission.create({
          data: { tenantId, permissionSetId: set.id, name: 'export_reports' },
        });
        id['exporters'] = set.id;
        id['analysts'] = (
          await tx.prisma.permissionSetGroup.create({ data: { tenantId, name: 'Analysts' } })
        ).id;
        await visibility.rebuild(tx);
      }
    }, tenant);
  }
});

afterAll(async () => {
  await api.dispose();
});

describe('POST /v1/invitations', () => {
  it('creates a pending user, emails a 7-day invitation and audits it', async () => {
    const res = await call('admin', 'POST', '/v1/invitations', {
      email: 'Carol@Users.test',
      name: 'Carol',
      profileId: get(`${tenantId}:std`),
      orgUnitId: get('field'),
      title: 'Account Executive',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      id: string;
      status: string;
      email: string;
      invitation: { expiresAt: string };
    }>();
    expect(body).toMatchObject({
      status: 'PENDING',
      email: 'carol@users.test',
      orgUnit: { name: 'Field' },
    });
    const days = (new Date(body.invitation.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    id['carol'] = body.id;
    expect(inviteToken('carol@users.test')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(api.email.lastTo('carol@users.test')?.subject).toContain('invited you to users Ltd');
    const audited = await inTenant((tx) =>
      tx.prisma.setupAudit.count({ where: { action: 'user.invited' } }),
    );
    expect(audited).toBe(1);
    // The manager of the org unit above sees the new user's records straight away.
    expect(await inTenant((tx) => visibility.ownersVisibleTo(tx, get('boss')))).toContain(body.id);
  });

  it('validates the body and its references, and refuses a duplicate email', async () => {
    const base = { email: 'dave@users.test', name: 'Dave', profileId: get(`${tenantId}:std`) };
    expect(
      (await call('admin', 'POST', '/v1/invitations', { ...base, email: 'nope' })).statusCode,
    ).toBe(400);
    expect(
      (await call('admin', 'POST', '/v1/invitations', { ...base, orgUnitId: get('exporters') }))
        .statusCode,
    ).toBe(400);
    expect((await call('admin', 'POST', '/v1/invitations', { ...base, extra: 1 })).statusCode).toBe(
      400,
    );
    expect(
      (await call('admin', 'POST', '/v1/invitations', { ...base, email: 'rep@users.test' }))
        .statusCode,
    ).toBe(409);
  });

  it('requires manage_users', async () => {
    const res = await call('rep', 'POST', '/v1/invitations', {
      email: 'x@users.test',
      name: 'X',
      profileId: get(`${tenantId}:std`),
    });
    expect(res.statusCode).toBe(403);
  });

  it('cannot use another tenant’s profile', async () => {
    const res = await call(
      'otherAdmin',
      'POST',
      '/v1/invitations',
      { email: 'y@other.test', name: 'Y', profileId: get(`${tenantId}:std`) },
      otherTenant,
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /auth/invitations/accept', () => {
  it('rejects a weak password and a token presented to another workspace', async () => {
    const token = inviteToken('carol@users.test');
    expect((await accept(token, 'short')).statusCode).toBe(400);
    expect((await accept(token, PASSWORD, otherTenant)).statusCode).toBe(400);
  });

  it('activates the user with a password and signs them in, once', async () => {
    const token = inviteToken('carol@users.test');
    const res = await accept(token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', user: { email: 'carol@users.test' } });
    expect((await accept(token)).statusCode).toBe(400);
    const login = await api.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-sm-tenant-id': tenantId },
      payload: { email: 'carol@users.test', password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
  });

  it('refuses an expired invitation', async () => {
    const invited = await call('admin', 'POST', '/v1/invitations', {
      email: 'late@users.test',
      name: 'Late',
      profileId: get(`${tenantId}:ro`),
    });
    id['late'] = invited.json<{ id: string }>().id;
    await inTenant((tx) =>
      tx.prisma.invitation.updateMany({
        where: { userId: get('late') },
        data: { expiresAt: new Date(Date.now() - 1000) },
      }),
    );
    expect((await accept(inviteToken('late@users.test'))).statusCode).toBe(400);
    const detail = await call('admin', 'GET', `/v1/users/${get('late')}`);
    expect(detail.json()).toMatchObject({ invitation: { expired: true } });
  });
});

describe('POST /v1/invitations/{id}/resend', () => {
  it('sends a fresh link and retires the old one', async () => {
    const old = inviteToken('late@users.test');
    expect((await call('admin', 'POST', `/v1/invitations/${get('late')}/resend`)).statusCode).toBe(
      200,
    );
    const fresh = inviteToken('late@users.test');
    expect(fresh).not.toBe(old);
    expect((await accept(old)).statusCode).toBe(400);
    expect((await accept(fresh)).statusCode).toBe(200);
  });

  it('refuses an accepted user, a non-manager and another tenant', async () => {
    expect((await call('admin', 'POST', `/v1/invitations/${get('late')}/resend`)).statusCode).toBe(
      409,
    );
    expect((await call('rep', 'POST', `/v1/invitations/${get('late')}/resend`)).statusCode).toBe(
      403,
    );
    expect(
      (
        await call(
          'otherAdmin',
          'POST',
          `/v1/invitations/${get('late')}/resend`,
          undefined,
          otherTenant,
        )
      ).statusCode,
    ).toBe(404);
    expect((await call('admin', 'POST', '/v1/invitations/nope/resend')).statusCode).toBe(400);
  });
});

describe('DELETE /v1/invitations/{id}', () => {
  it('withdraws an invitation and removes the pending user, freeing the address', async () => {
    const invited = await call('admin', 'POST', '/v1/invitations', {
      email: 'gone@users.test',
      name: 'Gone',
      profileId: get(`${tenantId}:std`),
    });
    const goneId = invited.json<{ id: string }>().id;
    const token = inviteToken('gone@users.test');
    expect((await call('rep', 'DELETE', `/v1/invitations/${goneId}`)).statusCode).toBe(403);
    expect(
      (await call('otherAdmin', 'DELETE', `/v1/invitations/${goneId}`, undefined, otherTenant))
        .statusCode,
    ).toBe(404);
    expect((await call('admin', 'DELETE', `/v1/invitations/${goneId}`)).statusCode).toBe(204);
    expect((await call('admin', 'GET', `/v1/users/${goneId}`)).statusCode).toBe(404);
    expect((await accept(token)).statusCode).toBe(400);
    const again = await call('admin', 'POST', '/v1/invitations', {
      email: 'gone@users.test',
      name: 'Gone again',
      profileId: get(`${tenantId}:std`),
    });
    expect(again.statusCode).toBe(201);
  });

  it('refuses to withdraw an accepted user', async () => {
    expect((await call('admin', 'DELETE', `/v1/invitations/${get('carol')}`)).statusCode).toBe(409);
  });
});

describe('GET /v1/users and /v1/users/{id}', () => {
  it('searches and pages users by name', async () => {
    const first = await call('admin', 'GET', '/v1/users?limit=2');
    const page = first.json<{ items: { name: string }[]; nextCursor: string }>();
    expect(page.items).toHaveLength(2);
    const second = await call('admin', 'GET', `/v1/users?limit=2&cursor=${page.nextCursor}`);
    expect(
      second
        .json<{ items: { name: string }[] }>()
        .items[0]?.name.localeCompare(page.items[1]?.name ?? ''),
    ).toBeGreaterThan(0);
    const found = await call('admin', 'GET', '/v1/users?q=caro');
    expect(found.json<{ items: { email: string }[] }>().items.map((u) => u.email)).toEqual([
      'carol@users.test',
    ]);
    const pending = await call('admin', 'GET', '/v1/users?status=PENDING');
    expect(
      pending.json<{ items: { status: string }[] }>().items.every((u) => u.status === 'PENDING'),
    ).toBe(true);
  });

  it('shows a user with their access', async () => {
    const res = await call('admin', 'GET', `/v1/users/${get('carol')}`);
    expect(res.json()).toMatchObject({
      status: 'ACTIVE',
      profile: { name: 'Standard User' },
      permissionSets: [],
      invitation: null,
    });
  });

  it('requires view_setup, validates, and stays in the tenant', async () => {
    expect((await call('rep', 'GET', '/v1/users')).statusCode).toBe(403);
    expect((await call('admin', 'GET', '/v1/users?cursor=@@')).statusCode).toBe(400);
    expect((await call('admin', 'GET', '/v1/users?limit=0')).statusCode).toBe(400);
    expect(
      (await call('otherAdmin', 'GET', `/v1/users/${get('carol')}`, undefined, otherTenant))
        .statusCode,
    ).toBe(404);
    const theirs = await call('otherAdmin', 'GET', '/v1/users', undefined, otherTenant);
    expect(theirs.json<{ items: { email: string }[] }>().items.map((u) => u.email)).toEqual([
      'otheradmin@users.test',
    ]);
  });
});

describe('PATCH /v1/users/{id}', () => {
  it('changes details and placement with an optimistic lock, and keeps visibility current', async () => {
    const before = (await call('admin', 'GET', `/v1/users/${get('rep')}`)).json<{
      version: number;
    }>();
    const res = await call('admin', 'PATCH', `/v1/users/${get('rep')}`, {
      version: before.version,
      title: 'Senior AE',
      orgUnitId: get('field'),
      managerId: get('boss'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      title: 'Senior AE',
      orgUnit: { name: 'Field' },
      manager: { id: get('boss') },
    });
    expect(await inTenant((tx) => visibility.ownersVisibleTo(tx, get('boss')))).toContain(
      get('rep'),
    );
    const stale = await call('admin', 'PATCH', `/v1/users/${get('rep')}`, {
      version: before.version,
      title: 'x',
    });
    expect(stale.statusCode).toBe(409);
    const trail = await inTenant((tx) =>
      tx.prisma.setupAudit.findFirstOrThrow({
        where: { action: 'user.updated', entityId: get('rep') },
      }),
    );
    expect(trail.after).toMatchObject({ title: 'Senior AE' });
  });

  it('refuses a manager cycle and unknown references', async () => {
    const boss = (await call('admin', 'GET', `/v1/users/${get('boss')}`)).json<{
      version: number;
    }>();
    const cycle = await call('admin', 'PATCH', `/v1/users/${get('boss')}`, {
      version: boss.version,
      managerId: get('rep'),
    });
    expect(cycle.statusCode).toBe(409);
    const unknown = await call('admin', 'PATCH', `/v1/users/${get('boss')}`, {
      version: boss.version,
      profileId: get('exporters'),
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('requires manage_users and stays in the tenant', async () => {
    expect(
      (await call('rep', 'PATCH', `/v1/users/${get('rep')}`, { version: 1, title: 'CEO' }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await call(
          'otherAdmin',
          'PATCH',
          `/v1/users/${get('rep')}`,
          { version: 1, title: 'x' },
          otherTenant,
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe('PUT /v1/users/{id}/assignments', () => {
  it('replaces permission sets and groups, and the new permissions apply', async () => {
    const res = await call('admin', 'PUT', `/v1/users/${get('rep')}/assignments`, {
      permissionSetIds: [get('exporters')],
      permissionSetGroupIds: [get('analysts')],
    });
    expect(res.json()).toMatchObject({
      permissionSets: [{ name: 'Exporters' }],
      permissionSetGroups: [{ name: 'Analysts' }],
    });
    const cleared = await call('admin', 'PUT', `/v1/users/${get('rep')}/assignments`, {
      permissionSetIds: [],
      permissionSetGroupIds: [],
    });
    expect(cleared.json()).toMatchObject({ permissionSets: [], permissionSetGroups: [] });
  });

  it('refuses a profile’s own set, a non-manager and another tenant', async () => {
    const profileSet = await inTenant((tx) =>
      tx.prisma.permissionSet.findFirstOrThrow({ where: { kind: 'PROFILE' } }),
    );
    const body = { permissionSetIds: [profileSet.id], permissionSetGroupIds: [] };
    expect(
      (await call('admin', 'PUT', `/v1/users/${get('rep')}/assignments`, body)).statusCode,
    ).toBe(400);
    expect(
      (
        await call('rep', 'PUT', `/v1/users/${get('rep')}/assignments`, {
          permissionSetIds: [],
          permissionSetGroupIds: [],
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call(
          'otherAdmin',
          'PUT',
          `/v1/users/${get('rep')}/assignments`,
          { permissionSetIds: [], permissionSetGroupIds: [] },
          otherTenant,
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe('POST /v1/users/{id}/deactivate and /reactivate', () => {
  it('ends every session at once and blocks sign-in, until reactivated', async () => {
    const signIn = () =>
      api.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'x-sm-tenant-id': tenantId },
        payload: { email: 'carol@users.test', password: PASSWORD },
      });
    const session = (await signIn()).json<{ tokens: { accessToken: string } }>().tokens;
    expect(
      (await call('admin', 'POST', `/v1/users/${get('carol')}/deactivate`)).json(),
    ).toMatchObject({ deactivated: true });
    const me = await api.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(me.statusCode).toBe(401);
    expect((await signIn()).statusCode).toBe(401);
    expect(
      (await call('admin', 'POST', `/v1/users/${get('carol')}/reactivate`)).json(),
    ).toMatchObject({ deactivated: false });
    expect((await signIn()).statusCode).toBe(200);
  });

  it('refuses to deactivate the owner or oneself, or a pending user', async () => {
    expect((await call('admin', 'POST', `/v1/users/${get('admin')}/deactivate`)).statusCode).toBe(
      409,
    );
    const pending = await call('admin', 'POST', '/v1/invitations', {
      email: 'pending@users.test',
      name: 'Pending',
      profileId: get(`${tenantId}:std`),
    });
    expect(
      (await call('admin', 'POST', `/v1/users/${pending.json<{ id: string }>().id}/deactivate`))
        .statusCode,
    ).toBe(409);
  });

  it('requires manage_users and stays in the tenant', async () => {
    expect((await call('rep', 'POST', `/v1/users/${get('carol')}/deactivate`)).statusCode).toBe(
      403,
    );
    expect((await call('rep', 'POST', `/v1/users/${get('carol')}/reactivate`)).statusCode).toBe(
      403,
    );
    expect(
      (
        await call(
          'otherAdmin',
          'POST',
          `/v1/users/${get('carol')}/deactivate`,
          undefined,
          otherTenant,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(
          'otherAdmin',
          'POST',
          `/v1/users/${get('carol')}/reactivate`,
          undefined,
          otherTenant,
        )
      ).statusCode,
    ).toBe(404);
  });
});
