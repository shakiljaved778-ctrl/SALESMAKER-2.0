import { type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { visibility, withTenant, type CellPrisma, type TenantTransaction } from '@sm/db';
import { grantManualShare } from '@sm/query-engine';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AccessService } from '../src/access/access.service.js';
import {
  RequireSystemPermission,
  SystemPermissionGuard,
} from '../src/access/system-permission.guard.js';
import { provisionDefaultProfiles } from '../src/permissions/default-profiles.js';
import { provisionOrgWideDefaults } from '../src/sharing/sharing.service.js';
import { PRISMA } from '../src/tokens.js';
import { startTestApi, type TestApi } from './support.js';

let api: TestApi;
let prisma: CellPrisma;
let access: AccessService;
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

beforeAll(async () => {
  api = await startTestApi({}, { recordTables: (object) => `fx_${object}` });
  prisma = api.app.get<symbol, CellPrisma>(PRISMA);
  access = api.app.get(AccessService);
  const migrator = new pg.Client({ connectionString: api.db.migratorUrl });
  await migrator.connect();
  await migrator.query(`
    CREATE TABLE fx_account (tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT uuid_generate_v7(),
      owner_id uuid NOT NULL, name text NOT NULL, website text, budget__c numeric,
      PRIMARY KEY (tenant_id, id));
    CREATE TABLE fx_contact (tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT uuid_generate_v7(),
      owner_id uuid NOT NULL, last_name text NOT NULL, account_id uuid, PRIMARY KEY (tenant_id, id));
    SELECT enable_tenant_rls('fx_account');
    SELECT enable_tenant_rls('fx_contact');`);
  await migrator.end();

  tenantId = await api.seedTenant('access');
  otherTenant = await api.seedTenant('access-other');
  for (const name of ['boss', 'rep', 'other', 'ro', 'admin'])
    id[name] = await api.seedUser(tenantId, `${name}@access.test`, 'a sturdy passphrase 4821');
  id['stranger'] = await api.seedUser(
    otherTenant,
    'stranger@other.test',
    'a sturdy passphrase 4821',
  );
  await inTenant(async (tx) => {
    const profiles = await provisionDefaultProfiles(tx, tenantId, 'en');
    await provisionOrgWideDefaults(tx);
    const p = tx.prisma;
    id['top'] = (await p.orgUnit.create({ data: { tenantId, name: 'top' } })).id;
    id['field'] = (
      await p.orgUnit.create({ data: { tenantId, name: 'field', parentId: get('top') } })
    ).id;
    const place = (user: string, data: Record<string, string | null>) =>
      p.user.update({ where: { tenantId_id: { tenantId, id: get(user) } }, data });
    await place('boss', { orgUnitId: get('top'), profileId: profiles.standard_user });
    await place('rep', { orgUnitId: get('field'), profileId: profiles.standard_user });
    await place('other', { profileId: profiles.standard_user });
    await place('ro', { profileId: profiles.read_only });
    await place('admin', { profileId: profiles.system_administrator });
    await visibility.rebuild(tx);
    for (const [name, owner] of [
      ['acc_rep', 'rep'],
      ['acc_other', 'other'],
    ] as const) {
      const [row] = await tx.kysely
        .insertInto('fx_account')
        .values({ tenant_id: tenantId, owner_id: get(owner), name })
        .returning('id')
        .execute();
      id[name] = String(row?.['id']);
    }
    const [contact] = await tx.kysely
      .insertInto('fx_contact')
      .values({
        tenant_id: tenantId,
        owner_id: get('other'),
        last_name: 'c1',
        account_id: get('acc_rep'),
      })
      .returning('id')
      .execute();
    id['c1'] = String(contact?.['id']);
    await grantManualShare(tx.kysely, {
      tenantId,
      object: 'account',
      recordId: get('acc_rep'),
      principal: { type: 'USER', id: get('other') },
      access: 1,
    });
  });
});

afterAll(async () => {
  await api.dispose();
});

describe('AccessService.check: the §6.2 layers, in order', () => {
  it.each<
    [string, Parameters<AccessService['check']>[2], Awaited<ReturnType<AccessService['check']>>]
  >([
    [
      'owner edits their record',
      { object: 'account', action: 'edit', recordId: 'acc_rep' },
      { allowed: true },
    ],
    [
      'owner deletes their record',
      { object: 'account', action: 'delete', recordId: 'acc_rep' },
      { allowed: true },
    ],
    [
      'no access to a peer’s record',
      { object: 'account', action: 'read', recordId: 'acc_other' },
      { allowed: false, deniedBy: 'record' },
    ],
    [
      'create needs only the object permission',
      { object: 'account', action: 'create' },
      { allowed: true },
    ],
    [
      'FLS refuses an ungranted field',
      { object: 'account', action: 'read', recordId: 'acc_rep', fields: ['website', 'budget__c'] },
      { allowed: false, deniedBy: 'field', deniedFields: ['budget__c'] },
    ],
    [
      'required fields stay editable',
      { object: 'account', action: 'edit', recordId: 'acc_rep', fields: ['name', 'website'] },
      { allowed: true },
    ],
  ])('rep: %s', async (_, request, expected) => {
    const resolved = {
      ...request,
      ...(request.recordId ? { recordId: get(request.recordId) } : {}),
    };
    expect(await inTenant((tx) => access.check(tx, get('rep'), resolved))).toEqual(expected);
  });

  it('checks object permissions before record access', async () => {
    expect(
      await inTenant((tx) =>
        access.check(tx, get('ro'), {
          object: 'account',
          action: 'edit',
          recordId: get('acc_rep'),
        }),
      ),
    ).toEqual({ allowed: false, deniedBy: 'object' });
  });

  it('gives a manager full access through the hierarchy', async () => {
    for (const action of ['edit', 'delete', 'transfer', 'share'] as const)
      expect(
        await inTenant((tx) =>
          access.check(tx, get('boss'), { object: 'account', action, recordId: get('acc_rep') }),
        ),
        action,
      ).toEqual({ allowed: true });
  });

  it('limits a Read share to reading', async () => {
    const check = (action: 'read' | 'edit' | 'transfer') =>
      inTenant((tx) =>
        access.check(tx, get('other'), { object: 'account', action, recordId: get('acc_rep') }),
      );
    expect(await check('read')).toEqual({ allowed: true });
    expect(await check('edit')).toEqual({ allowed: false, deniedBy: 'record' });
    expect(await check('transfer')).toEqual({ allowed: false, deniedBy: 'record' });
  });

  it('answers 404 for an invisible record and 403 for a visible one the user may not change', async () => {
    await expect(
      inTenant((tx) =>
        access.assert(tx, get('rep'), {
          object: 'account',
          action: 'edit',
          recordId: get('acc_other'),
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      inTenant((tx) =>
        access.assert(tx, get('other'), {
          object: 'account',
          action: 'edit',
          recordId: get('acc_rep'),
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      inTenant((tx) => access.assert(tx, get('ro'), { object: 'account', action: 'create' })),
    ).rejects.toMatchObject({ status: 403 });
    await inTenant((tx) =>
      access.assert(tx, get('rep'), {
        object: 'account',
        action: 'edit',
        recordId: get('acc_rep'),
      }),
    );
  });

  it('treats an object without records yet (no table before P02) as nothing visible', async () => {
    expect(
      await inTenant((tx) => access.recordAccess(tx, get('admin'), 'lead', get('acc_rep'))),
    ).toBe('none');
  });
});

describe('system permissions (§6.2 layer 2)', () => {
  class Probe {
    @RequireSystemPermission('view_setup')
    setup() {}
    open() {}
  }
  const guard = () => api.app.get(SystemPermissionGuard);
  const contextFor = (handler: keyof Probe, userId: string | null) =>
    ({
      getHandler: () => Object.getOwnPropertyDescriptor(Probe.prototype, handler)?.value as unknown,
      getClass: () => Probe,
      switchToHttp: () => ({
        getRequest: () => ({
          caller: userId ? { tenantId, userId, cellId: 'eu-central-1' } : undefined,
        }),
      }),
    }) as unknown as ExecutionContext;

  it('lets an administrator through and refuses everyone else with 403', async () => {
    expect(await guard().canActivate(contextFor('setup', get('admin')))).toBe(true);
    await expect(guard().canActivate(contextFor('setup', get('rep')))).rejects.toMatchObject({
      status: 403,
    });
    await expect(guard().canActivate(contextFor('setup', null))).rejects.toMatchObject({
      status: 401,
    });
    expect(await guard().canActivate(contextFor('open', get('rep')))).toBe(true);
    expect(api.app.get(Reflector)).toBeDefined();
  });
});

describe('AccessService.describe (“Why can I see this?”)', () => {
  const describeFor = (user: string, object: string, record: string) =>
    inTenant((tx) => access.describe(tx, get(user), object, get(record)));

  it('explains ownership, hierarchy and shares', async () => {
    expect(await describeFor('rep', 'account', 'acc_rep')).toMatchObject({
      access: 'full',
      reasons: [{ kind: 'OWNER', level: 'full' }],
    });
    expect(await describeFor('boss', 'account', 'acc_rep')).toMatchObject({
      access: 'full',
      reasons: [{ kind: 'HIERARCHY', level: 'full', ownerId: get('rep') }],
    });
    expect(await describeFor('other', 'account', 'acc_rep')).toMatchObject({
      access: 'read',
      reasons: [
        {
          kind: 'SHARE',
          level: 'read',
          shareReason: 'MANUAL',
          principalType: 'USER',
          principalId: get('other'),
        },
      ],
    });
  });

  it('explains administrators’ object permissions', async () => {
    const result = await describeFor('admin', 'account', 'acc_rep');
    expect(result?.access).toBe('full');
    expect(result?.reasons).toContainEqual({
      kind: 'OBJECT_PERMISSION',
      level: 'full',
      permission: 'modify_all',
    });
  });

  it('explains access that comes from a parent record', async () => {
    expect(await describeFor('rep', 'contact', 'c1')).toMatchObject({
      access: 'full',
      reasons: [
        { kind: 'PARENT', level: 'full', parentObject: 'account', parentId: get('acc_rep') },
      ],
    });
  });

  it('explains a public org-wide default', async () => {
    await inTenant((tx) =>
      tx.prisma.orgWideDefault.update({
        where: { tenantId_object: { tenantId, object: 'account' } },
        data: { sharingModel: 'PUBLIC_READ' },
      }),
    );
    try {
      expect(await describeFor('boss', 'account', 'acc_other')).toMatchObject({
        access: 'read',
        reasons: [{ kind: 'ORG_WIDE_DEFAULT', level: 'read', sharingModel: 'PUBLIC_READ' }],
      });
    } finally {
      await inTenant((tx) =>
        tx.prisma.orgWideDefault.update({
          where: { tenantId_object: { tenantId, object: 'account' } },
          data: { sharingModel: 'PRIVATE' },
        }),
      );
    }
  });

  it('returns nothing for a record the user cannot see', async () => {
    expect(await describeFor('rep', 'account', 'acc_other')).toBeNull();
    expect(await describeFor('ro', 'account', 'acc_other')).toBeNull();
  });
});

describe('GET /v1/me/access/{object}/{id}', () => {
  const request = async (user: string | null, path: string, tenant = tenantId) =>
    api.app.inject({
      method: 'GET',
      url: `/v1/me/access/${path}`,
      headers: user ? { authorization: `Bearer ${await api.tokenFor(tenant, get(user))}` } : {},
    });

  it('explains the caller’s access', async () => {
    const res = await request('boss', `account/${get('acc_rep')}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      object: 'account',
      recordId: get('acc_rep'),
      access: 'full',
      objectPermissions: { read: true, modifyAll: false },
      reasons: [{ kind: 'HIERARCHY' }],
    });
  });

  it('answers 404 for a record the caller cannot see', async () => {
    expect((await request('rep', `account/${get('acc_other')}`)).statusCode).toBe(404);
  });

  it('answers 404 across tenants (never 403)', async () => {
    expect((await request('stranger', `account/${get('acc_rep')}`, otherTenant)).statusCode).toBe(
      404,
    );
  });

  it('validates the object and id, and requires a session', async () => {
    expect((await request('rep', `Account!/${get('acc_rep')}`)).statusCode).toBe(400);
    expect((await request('rep', 'account/not-a-uuid')).statusCode).toBe(400);
    expect((await request(null, `account/${get('acc_rep')}`)).statusCode).toBe(401);
  });
});
