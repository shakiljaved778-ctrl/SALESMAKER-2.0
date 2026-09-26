import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createCellPrisma, disposeCellPrisma, type CellPrisma } from '../src/client.js';
import { withTenant, type TenantTransaction } from '../src/tenant.js';
import { createTestCellDatabase, type TestCellDatabase } from '../src/testing/cell-database.js';

const TENANT = '01920000-0000-7000-8000-0000000000c1';
const OTHER = '01920000-0000-7000-8000-0000000000c2';

let db: TestCellDatabase;
let prisma: CellPrisma;

type Tx = TenantTransaction['prisma'];
const inTenant = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(prisma, { tenantId }, ({ prisma: tx }) => fn(tx));
const permVersion = (tenantId: string) =>
  inTenant(
    tenantId,
    async (tx) => (await tx.tenantSettings.findUniqueOrThrow({ where: { tenantId } })).permVersion,
  );

let userId = '';
let standardSetId = '';
let mutingSetId = '';
let profileSetId = '';

beforeAll(async () => {
  db = await createTestCellDatabase(inject('pgServerAdminUrl'));
  prisma = createCellPrisma(db.appUrl);
  for (const [tenantId, slug] of [
    [TENANT, 'perm-a'],
    [OTHER, 'perm-b'],
  ] as const) {
    await inTenant(tenantId, (tx) =>
      tx.tenantSettings.create({
        data: {
          tenantId,
          name: slug,
          slug,
          region: 'eu-central-1',
          corporateCurrency: 'USD',
          defaultTimezone: 'UTC',
        },
      }),
    );
  }
  await inTenant(TENANT, async (tx) => {
    const profileSet = await tx.permissionSet.create({
      data: { tenantId: TENANT, kind: 'PROFILE', name: 'Rep' },
    });
    const profile = await tx.profile.create({
      data: { tenantId: TENANT, name: 'Rep', permissionSetId: profileSet.id },
    });
    const user = await tx.user.create({
      data: { tenantId: TENANT, email: 'rep@perm.test', name: 'Rep', profileId: profile.id },
    });
    const standard = await tx.permissionSet.create({ data: { tenantId: TENANT, name: 'Exports' } });
    const muting = await tx.permissionSet.create({
      data: { tenantId: TENANT, kind: 'MUTING', name: 'Mute exports' },
    });
    userId = user.id;
    standardSetId = standard.id;
    mutingSetId = muting.id;
    profileSetId = profileSet.id;
  });
});

afterAll(async () => {
  await disposeCellPrisma(prisma);
  await db.drop();
});

describe('permission grants (§6.2)', () => {
  it('stores system, object and field grants per permission set', async () => {
    await inTenant(TENANT, async (tx) => {
      await tx.systemPermission.create({
        data: { tenantId: TENANT, permissionSetId: standardSetId, name: 'export_reports' },
      });
      await tx.objectPermission.create({
        data: {
          tenantId: TENANT,
          permissionSetId: profileSetId,
          object: 'lead',
          canRead: true,
          canCreate: true,
          canEdit: true,
        },
      });
      await tx.fieldPermission.create({
        data: {
          tenantId: TENANT,
          permissionSetId: profileSetId,
          object: 'lead',
          field: 'email',
          canRead: true,
        },
      });
      const set = await tx.permissionSet.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: TENANT, id: profileSetId } },
        include: { objectPermissions: true, fieldPermissions: true, profile: true },
      });
      expect(set.profile?.name).toBe('Rep');
      expect(set.objectPermissions).toHaveLength(1);
      expect(set.fieldPermissions).toHaveLength(1);
    });
  });

  it.each([
    ['edit without read', { canEdit: true }],
    ['create without read', { canCreate: true }],
    ['delete without edit', { canRead: true, canDelete: true }],
    ['view all without read', { viewAll: true }],
    ['modify all without delete', { canRead: true, canEdit: true, viewAll: true, modifyAll: true }],
  ])('rejects object access with %s', async (_, flags) => {
    await expect(
      inTenant(TENANT, (tx) =>
        tx.objectPermission.create({
          data: { tenantId: TENANT, permissionSetId: standardSetId, object: 'account', ...flags },
        }),
      ),
    ).rejects.toThrow(/object_permission_dependencies/);
  });

  it('rejects field edit without read', async () => {
    await expect(
      inTenant(TENANT, (tx) =>
        tx.fieldPermission.create({
          data: {
            tenantId: TENANT,
            permissionSetId: standardSetId,
            object: 'lead',
            field: 'phone',
            canEdit: true,
          },
        }),
      ),
    ).rejects.toThrow(/field_permission_edit_needs_read/);
  });
});

describe('permission set kinds', () => {
  it('assigns and groups only standard sets, and mutes only with a muting set', async () => {
    await inTenant(TENANT, async (tx) => {
      const group = await tx.permissionSetGroup.create({
        data: { tenantId: TENANT, name: 'Analysts', mutingSetId },
      });
      await tx.permissionSetGroupMember.create({
        data: { tenantId: TENANT, groupId: group.id, permissionSetId: standardSetId },
      });
      await tx.permissionAssignment.create({
        data: { tenantId: TENANT, userId, permissionSetId: standardSetId },
      });
      await tx.permissionAssignment.create({
        data: { tenantId: TENANT, userId, permissionSetGroupId: group.id },
      });
      expect(await tx.permissionAssignment.count({ where: { userId } })).toBe(2);
    });
    const cases: [string, (tx: Tx) => Promise<unknown>][] = [
      [
        'assign a profile set',
        (tx) =>
          tx.permissionAssignment.create({
            data: { tenantId: TENANT, userId, permissionSetId: profileSetId },
          }),
      ],
      [
        'assign a muting set',
        (tx) =>
          tx.permissionAssignment.create({
            data: { tenantId: TENANT, userId, permissionSetId: mutingSetId },
          }),
      ],
      [
        'group a muting set',
        async (tx) => {
          const g = await tx.permissionSetGroup.findFirstOrThrow({ where: { name: 'Analysts' } });
          return tx.permissionSetGroupMember.create({
            data: { tenantId: TENANT, groupId: g.id, permissionSetId: mutingSetId },
          });
        },
      ],
      [
        'mute with a standard set',
        (tx) =>
          tx.permissionSetGroup.create({
            data: { tenantId: TENANT, name: 'Bad', mutingSetId: standardSetId },
          }),
      ],
      [
        'give a profile a standard set',
        (tx) =>
          tx.profile.create({
            data: { tenantId: TENANT, name: 'Bad', permissionSetId: standardSetId },
          }),
      ],
      [
        'change a set kind',
        (tx) =>
          tx.permissionSet.update({
            where: { tenantId_id: { tenantId: TENANT, id: standardSetId } },
            data: { kind: 'MUTING' },
          }),
      ],
    ];
    for (const [what, run] of cases)
      await expect(inTenant(TENANT, run), what).rejects.toThrow(
        /permission_set_kind|must reference|cannot change/,
      );
  });

  it('requires exactly one target per assignment', async () => {
    await expect(
      inTenant(TENANT, (tx) =>
        tx.permissionAssignment.create({ data: { tenantId: TENANT, userId } }),
      ),
    ).rejects.toThrow(/permission_assignment_one_target/);
  });
});

describe('perm_version (§6.4 cache key)', () => {
  it('bumps on every change that can alter effective permissions or principals', async () => {
    const changes: [string, (tx: Tx) => Promise<unknown>][] = [
      [
        'grant',
        (tx) =>
          tx.systemPermission.create({
            data: { tenantId: TENANT, permissionSetId: standardSetId, name: 'run_reports' },
          }),
      ],
      [
        'revoke',
        (tx) =>
          tx.systemPermission.deleteMany({
            where: { permissionSetId: standardSetId, name: 'run_reports' },
          }),
      ],
      [
        'object grant',
        (tx) =>
          tx.objectPermission.updateMany({ where: { object: 'lead' }, data: { canDelete: true } }),
      ],
      [
        'new set',
        (tx) =>
          tx.permissionSet.create({
            data: { tenantId: TENANT, name: `Set ${String(Math.random())}` },
          }),
      ],
      [
        'unassign',
        (tx) =>
          tx.permissionAssignment.deleteMany({ where: { userId, permissionSetId: standardSetId } }),
      ],
      ['org unit', (tx) => tx.orgUnit.create({ data: { tenantId: TENANT, name: 'Sales' } })],
      [
        'user placement',
        async (tx) => {
          const unit = await tx.orgUnit.findFirstOrThrow({ where: { name: 'Sales' } });
          return tx.user.update({
            where: { tenantId_id: { tenantId: TENANT, id: userId } },
            data: { orgUnitId: unit.id },
          });
        },
      ],
      [
        'deactivate',
        (tx) =>
          tx.user.update({
            where: { tenantId_id: { tenantId: TENANT, id: userId } },
            data: { deactivatedAt: new Date() },
          }),
      ],
    ];
    for (const [what, change] of changes) {
      const before = await permVersion(TENANT);
      await inTenant(TENANT, change);
      expect(await permVersion(TENANT), what).toBeGreaterThan(before);
    }
  });

  it('does not bump for unrelated user edits or for other tenants', async () => {
    const [before, otherBefore] = [await permVersion(TENANT), await permVersion(OTHER)];
    await inTenant(TENANT, (tx) =>
      tx.user.update({
        where: { tenantId_id: { tenantId: TENANT, id: userId } },
        data: { name: 'Renamed', title: 'AE' },
      }),
    );
    await inTenant(TENANT, (tx) =>
      tx.systemPermission.create({
        data: { tenantId: TENANT, permissionSetId: standardSetId, name: 'mass_update' },
      }),
    );
    expect(await permVersion(TENANT)).toBe(before + 1);
    expect(await permVersion(OTHER)).toBe(otherBefore);
  });
});

describe('isolation', () => {
  it('shows another tenant none of these rows', async () => {
    const counts = await inTenant(OTHER, async (tx) => [
      await tx.profile.count(),
      await tx.permissionSet.count(),
      await tx.permissionSetGroup.count(),
      await tx.permissionAssignment.count(),
      await tx.systemPermission.count(),
      await tx.objectPermission.count(),
      await tx.fieldPermission.count(),
    ]);
    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});
