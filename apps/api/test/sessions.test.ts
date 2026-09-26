import { withTenant, type CellPrisma } from '@sm/db';
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

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

async function login(email: string, password = PASSWORD, tenant = tenantId) {
  return api.app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { 'x-sm-tenant-id': tenant, 'user-agent': `agent-${email}` },
    payload: { email, password },
  });
}
async function tokens(email: string, tenant = tenantId): Promise<Tokens> {
  const res = await login(email, PASSWORD, tenant);
  return res.json<{ tokens: Tokens }>().tokens;
}
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, accessToken: string) =>
  api.app.inject({ method, url, headers: { authorization: `Bearer ${accessToken}` } });
const history = (where: Record<string, unknown> = {}) =>
  withTenant(prisma, { tenantId }, (tx) =>
    tx.prisma.loginHistory.findMany({ where, orderBy: { id: 'asc' } }),
  );

beforeAll(async () => {
  api = await startTestApi();
  prisma = api.app.get<symbol, CellPrisma>(PRISMA);
  tenantId = await api.seedTenant('sessions');
  otherTenant = await api.seedTenant('sessions-other');
  id['admin'] = await api.seedUser(tenantId, 'admin@sessions.test', PASSWORD);
  id['rep'] = await api.seedUser(tenantId, 'rep@sessions.test', PASSWORD);
  id['new'] = await api.seedUser(tenantId, 'new@sessions.test', PASSWORD, { verified: false });
  id['outsider'] = await api.seedUser(otherTenant, 'outsider@other.test', PASSWORD);
  await withTenant(prisma, { tenantId }, async (tx) => {
    const profiles = await provisionDefaultProfiles(tx, tenantId, 'en');
    await tx.prisma.user.update({
      where: { tenantId_id: { tenantId, id: id['admin'] ?? '' } },
      data: { profileId: profiles.system_administrator },
    });
  });
});

afterAll(async () => {
  await api.dispose();
});

describe('login history (§6.1, §6.7)', () => {
  it('records a success with its session, and each kind of failure', async () => {
    expect((await login('rep@sessions.test')).statusCode).toBe(200);
    expect((await login('rep@sessions.test', 'wrong password 12345')).statusCode).toBe(401);
    expect((await login('ghost@sessions.test')).statusCode).toBe(401);
    expect((await login('new@sessions.test')).statusCode).toBe(403);
    const rows = await history();
    expect(rows.map((r) => [r.userId, r.outcome])).toEqual([
      [id['rep'], 'SUCCESS'],
      [id['rep'], 'INVALID_CREDENTIALS'],
      [null, 'INVALID_CREDENTIALS'],
      [id['new'], 'EMAIL_NOT_VERIFIED'],
    ]);
    expect(rows[0]).toMatchObject({ method: 'password', userAgent: 'agent-rep@sessions.test' });
    expect(rows[0]?.sessionId).toBeTruthy();
    expect(rows[2]?.emailHash).toBeTruthy(); // the unknown address, as an HMAC only
    expect(rows[1]?.emailHash).toBeNull();
  });

  it('records a lockout', async () => {
    for (let i = 0; i < 10; i += 1)
      await login('admin@sessions.test', `wrong password ${String(i)}0000`);
    expect((await login('admin@sessions.test')).statusCode).toBe(423);
    const locked = await history({ userId: id['admin'], outcome: 'LOCKED' });
    expect(locked.length).toBeGreaterThanOrEqual(2);
    await withTenant(prisma, { tenantId }, (tx) => tx.prisma.authAttempt.deleteMany());
  });

  it('refuses a deactivated user, and says only that the credentials do not match', async () => {
    await withTenant(prisma, { tenantId }, (tx) =>
      tx.prisma.user.update({
        where: { tenantId_id: { tenantId, id: id['new'] ?? '' } },
        data: { emailVerifiedAt: new Date(), status: 'ACTIVE', deactivatedAt: new Date() },
      }),
    );
    expect((await login('new@sessions.test')).statusCode).toBe(401);
  });

  it('is append-only', async () => {
    await expect(
      withTenant(prisma, { tenantId }, (tx) => tx.prisma.loginHistory.deleteMany()),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('/v1/me/sessions (§6.1)', () => {
  it('lists the caller’s live sessions and marks the current one', async () => {
    const laptop = await tokens('rep@sessions.test');
    await tokens('rep@sessions.test');
    const res = await call('GET', '/v1/me/sessions', laptop.accessToken);
    const items = res.json<{ items: { id: string; current: boolean; userAgent: string }[] }>()
      .items;
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.filter((s) => s.current)).toHaveLength(1);
    expect(items[0]?.userAgent).toBe('agent-rep@sessions.test');
  });

  it('signs out another session at once: its access token and refresh token stop working', async () => {
    const mine = await tokens('rep@sessions.test');
    const phone = await tokens('rep@sessions.test');
    const phoneSession = (await call('GET', '/v1/me/sessions', phone.accessToken))
      .json<{ items: { id: string; current: boolean }[] }>()
      .items.find((s) => s.current)?.id;
    expect(
      (await call('DELETE', `/v1/me/sessions/${phoneSession ?? ''}`, mine.accessToken)).statusCode,
    ).toBe(204);
    expect((await call('GET', '/v1/me', phone.accessToken)).statusCode).toBe(401);
    const refreshed = await api.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { 'x-sm-tenant-id': tenantId },
      payload: { refreshToken: phone.refreshToken },
    });
    expect(refreshed.statusCode).toBe(401);
    expect((await call('GET', '/v1/me', mine.accessToken)).statusCode).toBe(200);
    expect(
      (await call('DELETE', `/v1/me/sessions/${phoneSession ?? ''}`, mine.accessToken)).statusCode,
    ).toBe(404);
  });

  it('signs out everywhere else, keeping this session', async () => {
    const mine = await tokens('rep@sessions.test');
    const other = await tokens('rep@sessions.test');
    const res = await call('POST', '/v1/me/sessions/revoke-others', mine.accessToken);
    expect(res.json<{ revoked: number }>().revoked).toBeGreaterThanOrEqual(1);
    expect((await call('GET', '/v1/me', other.accessToken)).statusCode).toBe(401);
    const left = await call('GET', '/v1/me/sessions', mine.accessToken);
    expect(left.json<{ items: { current: boolean }[] }>().items).toEqual([
      expect.objectContaining({ current: true }),
    ]);
    const audited = await withTenant(prisma, { tenantId }, (tx) =>
      tx.prisma.auditLog.count({ where: { action: 'session.revoked_others' } }),
    );
    expect(audited).toBe(1);
  });

  it('cannot touch a session of another user or tenant (404)', async () => {
    const outsider = await tokens('outsider@other.test', otherTenant);
    const rep = await tokens('rep@sessions.test');
    const repSession = (await call('GET', '/v1/me/sessions', rep.accessToken))
      .json<{ items: { id: string; current: boolean }[] }>()
      .items.find((s) => s.current)?.id;
    expect(
      (await call('DELETE', `/v1/me/sessions/${repSession ?? ''}`, outsider.accessToken))
        .statusCode,
    ).toBe(404);
    expect((await call('GET', '/v1/me', rep.accessToken)).statusCode).toBe(200);
  });

  it('validates the id and requires a session', async () => {
    const rep = await tokens('rep@sessions.test');
    expect((await call('DELETE', '/v1/me/sessions/nope', rep.accessToken)).statusCode).toBe(400);
    expect((await api.app.inject({ method: 'GET', url: '/v1/me/sessions' })).statusCode).toBe(401);
  });
});

describe('login history endpoints', () => {
  it('shows the caller their own attempts only', async () => {
    const rep = await tokens('rep@sessions.test');
    const res = await call('GET', '/v1/me/login-history?limit=5', rep.accessToken);
    const page = res.json<{ items: { userId: string }[]; nextCursor: string }>();
    expect(page.items).toHaveLength(5);
    expect(page.items.every((i) => i.userId === id['rep'])).toBe(true);
    const next = await call(
      'GET',
      `/v1/me/login-history?cursor=${page.nextCursor}`,
      rep.accessToken,
    );
    expect(next.statusCode).toBe(200);
  });

  it('shows administrators the workspace’s attempts, filtered', async () => {
    await withTenant(prisma, { tenantId }, (tx) => tx.prisma.authAttempt.deleteMany());
    const admin = await tokens('admin@sessions.test');
    const res = await call(
      'GET',
      '/v1/login-history?outcome=EMAIL_NOT_VERIFIED',
      admin.accessToken,
    );
    expect(res.json<{ items: { userId: string }[] }>().items.map((i) => i.userId)).toEqual([
      id['new'],
    ]);
    const byUser = await call(
      'GET',
      `/v1/login-history?userId=${id['admin'] ?? ''}&outcome=LOCKED`,
      admin.accessToken,
    );
    expect(byUser.json<{ items: unknown[] }>().items.length).toBeGreaterThanOrEqual(1);
  });

  it('requires view_setup, stays in the tenant and validates input', async () => {
    const rep = await tokens('rep@sessions.test');
    expect((await call('GET', '/v1/login-history', rep.accessToken)).statusCode).toBe(403);
    const admin = await tokens('admin@sessions.test');
    expect((await call('GET', '/v1/login-history?cursor=zzz', admin.accessToken)).statusCode).toBe(
      400,
    );
    expect(
      (await call('GET', '/v1/login-history?outcome=MAYBE', admin.accessToken)).statusCode,
    ).toBe(400);
    const outsider = await tokens('outsider@other.test', otherTenant);
    const theirs = await call('GET', '/v1/me/login-history', outsider.accessToken);
    expect(
      theirs
        .json<{ items: { userId: string }[] }>()
        .items.every((i) => i.userId === id['outsider']),
    ).toBe(true);
  });
});
