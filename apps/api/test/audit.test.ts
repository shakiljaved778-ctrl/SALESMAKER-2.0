import {
  audit,
  createCellPrisma,
  disposeCellPrisma,
  withTenant,
  type CellPrisma,
  type TenantTransaction,
} from '@sm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { provisionDefaultProfiles } from '../src/permissions/default-profiles.js';
import { PRISMA } from '../src/tokens.js';
import { startTestApi, type TestApi } from './support.js';

let api: TestApi;
let prisma: CellPrisma;
let auditor: CellPrisma;
let tenantId = '';
let otherTenant = '';
const id: Record<string, string> = {};
const get = (n: string) => {
  const v = id[n];
  if (!v) throw new Error(`no fixture ${n}`);
  return v;
};
const inTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>, tenant = tenantId) =>
  withTenant(prisma, { tenantId: tenant }, fn);

async function call(user: string, url: string, tenant = tenantId) {
  return api.app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${await api.tokenFor(tenant, get(user))}` },
  });
}

beforeAll(async () => {
  api = await startTestApi();
  prisma = api.app.get<symbol, CellPrisma>(PRISMA);
  auditor = createCellPrisma(api.db.auditUrl);
  tenantId = await api.seedTenant('audit');
  otherTenant = await api.seedTenant('audit-other');
  for (const [name, tenant] of [
    ['admin', tenantId],
    ['rep', tenantId],
    ['outsider', otherTenant],
  ] as const)
    id[name] = await api.seedUser(tenant, `${name}@audit.test`, 'a sturdy passphrase 4821');
  for (const [tenant, users] of [
    [
      tenantId,
      [
        ['admin', 'system_administrator'],
        ['rep', 'standard_user'],
      ],
    ],
    [otherTenant, [['outsider', 'system_administrator']]],
  ] as const) {
    await inTenant(async (tx) => {
      const profiles = await provisionDefaultProfiles(tx, tenant, 'en');
      for (const [user, profile] of users)
        await tx.prisma.user.update({
          where: { tenantId_id: { tenantId: tenant, id: get(user) } },
          data: { profileId: profiles[profile] },
        });
    }, tenant);
  }
  await withTenant(prisma, { tenantId, userId: get('admin') }, async (tx) => {
    for (const [action, object] of [
      ['user.invited', null],
      ['record.created', 'lead'],
      ['record.updated', 'lead'],
    ] as const)
      await audit.record(tx, { action, ...(object ? { object } : {}), payload: { note: action } });
    await audit.setup(tx, {
      action: 'profile.created',
      entityType: 'profile',
      entityName: 'Rep',
      after: { name: 'Rep' },
    });
    await audit.setup(tx, {
      action: 'org_unit.created',
      entityType: 'org_unit',
      entityName: 'Sales',
    });
  });
  await inTenant((tx) => audit.record(tx, { action: 'secret.other_tenant' }), otherTenant);
});

afterAll(async () => {
  await disposeCellPrisma(auditor);
  await api.dispose();
});

describe('GET /v1/audit-log', () => {
  it('lists entries newest first, in pages, with filters', async () => {
    const first = await call('admin', '/v1/audit-log?limit=2');
    expect(first.statusCode).toBe(200);
    const page1 = first.json<{
      items: { seq: string; action: string; chained: boolean }[];
      nextCursor: string;
    }>();
    expect(page1.items.map((i) => i.seq)).toEqual(['3', '2']);
    expect(page1.items[0]).toMatchObject({ action: 'record.updated', chained: false });
    const second = await call('admin', `/v1/audit-log?limit=2&cursor=${page1.nextCursor}`);
    expect(second.json()).toMatchObject({
      items: [{ seq: '1', action: 'user.invited' }],
      nextCursor: null,
    });
    const leads = await call('admin', '/v1/audit-log?object=lead&action=record.created');
    expect(leads.json<{ items: unknown[] }>().items).toHaveLength(1);
    const byActor = await call('admin', `/v1/audit-log?actorId=${get('admin')}`);
    expect(byActor.json<{ items: unknown[] }>().items).toHaveLength(3);
  });

  it('shows whether an entry is chained', async () => {
    await audit.chain((fn) => withTenant(auditor, { tenantId }, fn));
    const res = await call('admin', '/v1/audit-log');
    expect(res.json<{ items: { chained: boolean }[] }>().items.every((i) => i.chained)).toBe(true);
  });

  it('requires view_setup (403)', async () => {
    expect((await call('rep', '/v1/audit-log')).statusCode).toBe(403);
  });

  it('shows another tenant’s administrator only their own log', async () => {
    const res = await call('outsider', '/v1/audit-log', otherTenant);
    expect(res.json<{ items: { action: string }[] }>().items.map((i) => i.action)).toEqual([
      'secret.other_tenant',
    ]);
  });

  it('validates paging', async () => {
    expect((await call('admin', '/v1/audit-log?limit=500')).statusCode).toBe(400);
    expect((await call('admin', '/v1/audit-log?cursor=abc')).statusCode).toBe(400);
  });
});

describe('GET /v1/audit-log/verification', () => {
  it('reports the chain head and the latest verification', async () => {
    const before = await call('admin', '/v1/audit-log/verification');
    expect(before.json()).toEqual({ lastVerification: null, chainedThroughSeq: '3', unchained: 0 });
    await inTenant((tx) =>
      tx.prisma.auditVerification.create({
        data: { tenantId, status: 'OK', throughSeq: 3n, batches: 1, rows: 3, pending: 0 },
      }),
    );
    const after = await call('admin', '/v1/audit-log/verification');
    expect(after.json()).toMatchObject({
      lastVerification: { status: 'OK', throughSeq: '3', rows: 3, problem: null },
    });
    expect((await call('rep', '/v1/audit-log/verification')).statusCode).toBe(403);
  });
});

describe('GET /v1/setup-audit', () => {
  it('lists Setup changes newest first, with filters and paging', async () => {
    const res = await call('admin', '/v1/setup-audit?limit=1');
    const page = res.json<{ items: { action: string; actorId: string }[]; nextCursor: string }>();
    expect(page.items).toMatchObject([{ action: 'org_unit.created', actorId: get('admin') }]);
    const next = await call('admin', `/v1/setup-audit?limit=1&cursor=${page.nextCursor}`);
    expect(next.json()).toMatchObject({
      items: [{ action: 'profile.created', after: { name: 'Rep' }, before: null }],
      nextCursor: null,
    });
    const profiles = await call('admin', '/v1/setup-audit?entityType=profile');
    expect(profiles.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it('requires view_setup, stays in the tenant and validates the cursor', async () => {
    expect((await call('rep', '/v1/setup-audit')).statusCode).toBe(403);
    expect((await call('outsider', '/v1/setup-audit', otherTenant)).json()).toEqual({
      items: [],
      nextCursor: null,
    });
    expect((await call('admin', '/v1/setup-audit?cursor=nope')).statusCode).toBe(400);
  });
});
