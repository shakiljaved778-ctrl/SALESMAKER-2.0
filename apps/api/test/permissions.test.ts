import { withTenant, type CellPrisma, type TenantTransaction } from '@sm/db';
import { fieldAccess, hasSystemPermission, objectAccess, PermissionCache } from '@sm/permissions';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { provisionDefaultProfiles } from '../src/permissions/default-profiles.js';
import { PermissionService, toGrants } from '../src/permissions/permission.service.js';
import { PRISMA, REDIS } from '../src/tokens.js';
import { startTestApi, type TestApi } from './support.js';

let api: TestApi;
let prisma: CellPrisma;
let service: PermissionService;
let tenantId = '';
let otherTenant = '';
let repId = '';
let profiles: Record<string, string> = {};

const inTenant = <T>(id: string, fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(prisma, { tenantId: id }, fn);
const effective = (id = repId, tenant = tenantId) =>
  inTenant(tenant, (tx) => service.forUser(tx, id));

beforeAll(async () => {
  api = await startTestApi();
  prisma = api.app.get<symbol, CellPrisma>(PRISMA);
  service = api.app.get(PermissionService);
  tenantId = await api.seedTenant('perms');
  otherTenant = await api.seedTenant('perms-other');
  repId = await api.seedUser(tenantId, 'rep@perms.test', 'a sturdy passphrase 4821');
  profiles = await inTenant(tenantId, async (tx) => {
    const ids = await provisionDefaultProfiles(tx, tenantId, 'en');
    await tx.prisma.user.update({
      where: { tenantId_id: { tenantId, id: repId } },
      data: { profileId: ids.standard_user },
    });
    return ids;
  });
});

afterAll(async () => {
  await api.dispose();
});

describe('PermissionService (§6.2)', () => {
  it('computes a Standard User’s permissions from their profile', async () => {
    const eff = await effective();
    expect(objectAccess(eff, 'lead')).toMatchObject({ read: true, delete: true, viewAll: false });
    expect(objectAccess(eff, 'product')).toMatchObject({ read: true, edit: false });
    expect(fieldAccess(eff, 'lead', 'email')).toEqual({ read: true, edit: true });
    expect(hasSystemPermission(eff, 'view_setup')).toBe(false);
  });

  it('caches under permVersion, and a grant change is visible at once', async () => {
    await effective();
    const version = await inTenant(
      tenantId,
      async (tx) =>
        (await tx.prisma.tenantSettings.findUniqueOrThrow({ where: { tenantId } })).permVersion,
    );
    const redis = api.app.get<symbol, Redis>(REDIS);
    expect(await redis.exists(PermissionCache.key(tenantId, repId, version))).toBe(1);

    await inTenant(tenantId, async ({ prisma: tx }) => {
      const set = await tx.permissionSet.create({ data: { tenantId, name: 'Exporters' } });
      await tx.systemPermission.create({
        data: { tenantId, permissionSetId: set.id, name: 'export_reports' },
      });
      await tx.permissionAssignment.create({
        data: { tenantId, userId: repId, permissionSetId: set.id },
      });
    });
    expect(hasSystemPermission(await effective(), 'export_reports')).toBe(true);
  });

  it('applies a group’s muting set to that group’s sets only', async () => {
    await inTenant(tenantId, async ({ prisma: tx }) => {
      const analyst = await tx.permissionSet.create({ data: { tenantId, name: 'Analyst' } });
      await tx.systemPermission.createMany({
        data: [
          { tenantId, permissionSetId: analyst.id, name: 'manage_dashboards' },
          { tenantId, permissionSetId: analyst.id, name: 'export_reports' },
        ],
      });
      const muting = await tx.permissionSet.create({
        data: { tenantId, kind: 'MUTING', name: 'No dashboards' },
      });
      await tx.systemPermission.create({
        data: { tenantId, permissionSetId: muting.id, name: 'manage_dashboards' },
      });
      const group = await tx.permissionSetGroup.create({
        data: { tenantId, name: 'Analysts', mutingSetId: muting.id },
      });
      await tx.permissionSetGroupMember.create({
        data: { tenantId, groupId: group.id, permissionSetId: analyst.id },
      });
      await tx.permissionAssignment.create({
        data: { tenantId, userId: repId, permissionSetGroupId: group.id },
      });
    });
    const eff = await effective();
    expect(hasSystemPermission(eff, 'manage_dashboards')).toBe(false);
    expect(hasSystemPermission(eff, 'export_reports')).toBe(true);
  });

  it('gives a deactivated user nothing, whatever is assigned', async () => {
    await inTenant(tenantId, (tx) =>
      tx.prisma.user.update({
        where: { tenantId_id: { tenantId, id: repId } },
        data: { deactivatedAt: new Date() },
      }),
    );
    const eff = await effective();
    expect(objectAccess(eff, 'lead').read).toBe(false);
    expect(eff.system.size).toBe(0);
    await inTenant(tenantId, (tx) =>
      tx.prisma.user.update({
        where: { tenantId_id: { tenantId, id: repId } },
        data: { deactivatedAt: null, profileId: profiles['system_administrator'] ?? null },
      }),
    );
    expect(hasSystemPermission(await effective(), 'view_setup')).toBe(true);
  });

  it('finds nothing for a user of another tenant', async () => {
    const eff = await effective(repId, otherTenant);
    expect(eff.system.size).toBe(0);
    expect(Object.keys(eff.objects)).toEqual([]);
  });

  it('maps grant rows, ignoring unknown system permissions', () => {
    expect(
      toGrants({
        systemPermissions: [{ name: 'run_reports' }, { name: 'retired_permission' }],
        objectPermissions: [],
        fieldPermissions: [{ object: 'lead', field: 'email', canRead: true, canEdit: false }],
      }),
    ).toEqual({
      system: ['run_reports'],
      objects: {},
      fields: { lead: { email: { read: true, edit: false } } },
    });
    expect(toGrants(null)).toEqual({ system: [], objects: {}, fields: {} });
    const deleted = toGrants({
      deletedAt: new Date(),
      systemPermissions: [{ name: 'run_reports' }],
      objectPermissions: [],
      fieldPermissions: [],
    });
    expect(deleted.system).toEqual([]);
  });
});
