import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createCellPrisma, disposeCellPrisma, type CellPrisma } from '../src/client.js';
import { membership } from '../src/membership.js';
import { withTenant, type TenantTransaction } from '../src/tenant.js';
import { createTestCellDatabase, type TestCellDatabase } from '../src/testing/cell-database.js';

const TENANT = '01920000-0000-7000-8000-0000000000d1';
const OTHER = '01920000-0000-7000-8000-0000000000d2';

let db: TestCellDatabase;
let prisma: CellPrisma;

const inTenant = <T>(tenantId: string, fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(prisma, { tenantId }, fn);

// Fixture: ceo > sales > emea;  users: ana (ceo), ben (sales), cai (emea), dee (no unit).
const id: Record<string, string> = {};
const sorted = (...names: string[]) => names.map((n) => id[n] ?? n).sort();

async function group(tx: TenantTransaction, name: string) {
  const g = await tx.prisma.publicGroup.create({ data: { tenantId: TENANT, name } });
  id[name] = g.id;
  return g.id;
}

beforeAll(async () => {
  db = await createTestCellDatabase(inject('pgServerAdminUrl'));
  prisma = createCellPrisma(db.appUrl);
  for (const [tenantId, slug] of [
    [TENANT, 'grp-a'],
    [OTHER, 'grp-b'],
  ] as const) {
    await inTenant(tenantId, ({ prisma: tx }) =>
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
  await inTenant(TENANT, async ({ prisma: tx }) => {
    let parentId: string | null = null;
    for (const name of ['ceo', 'sales', 'emea']) {
      const unit: { id: string } = await tx.orgUnit.create({
        data: { tenantId: TENANT, name, parentId },
      });
      id[name] = unit.id;
      parentId = unit.id;
    }
    for (const [name, unit] of [
      ['ana', 'ceo'],
      ['ben', 'sales'],
      ['cai', 'emea'],
      ['dee', undefined],
    ] as const) {
      const u = await tx.user.create({
        data: {
          tenantId: TENANT,
          email: `${name}@grp.test`,
          name,
          orgUnitId: unit ? (id[unit] ?? null) : null,
        },
      });
      id[name] = u.id;
    }
  });
});

afterAll(async () => {
  await disposeCellPrisma(prisma);
  await db.drop();
});

describe('public groups (§6.3)', () => {
  it('expand users, org units, org-unit subtrees and nested groups to users', async () => {
    await inTenant(TENANT, async (tx) => {
      const direct = await group(tx, 'direct');
      const unit = await group(tx, 'unit');
      const subtree = await group(tx, 'subtree');
      const outer = await group(tx, 'outer');
      const { prisma: p } = tx;
      await p.groupMember.create({
        data: { tenantId: TENANT, groupId: direct, memberType: 'USER', userId: id['dee'] },
      });
      await p.groupMember.create({
        data: { tenantId: TENANT, groupId: unit, memberType: 'ORG_UNIT', orgUnitId: id['sales'] },
      });
      await p.groupMember.create({
        data: {
          tenantId: TENANT,
          groupId: subtree,
          memberType: 'ORG_UNIT_AND_SUBORDINATES',
          orgUnitId: id['sales'],
        },
      });
      await p.groupMember.create({
        data: { tenantId: TENANT, groupId: outer, memberType: 'GROUP', memberGroupId: direct },
      });
      await p.groupMember.create({
        data: { tenantId: TENANT, groupId: outer, memberType: 'GROUP', memberGroupId: unit },
      });

      expect(await membership.groupUsers(tx, direct)).toEqual(sorted('dee'));
      expect(await membership.groupUsers(tx, unit)).toEqual(sorted('ben'));
      expect(await membership.groupUsers(tx, subtree)).toEqual(sorted('ben', 'cai'));
      expect(await membership.groupUsers(tx, outer)).toEqual(sorted('ben', 'dee'));
    });
  });

  it('resolves the groups a user belongs to, including the groups that contain them', async () => {
    await inTenant(TENANT, async (tx) => {
      expect(await membership.userGroups(tx, id['ben'] ?? '')).toEqual(
        sorted('unit', 'subtree', 'outer'),
      );
      expect(await membership.userGroups(tx, id['cai'] ?? '')).toEqual(sorted('subtree'));
      expect(await membership.userGroups(tx, id['dee'] ?? '')).toEqual(sorted('direct', 'outer'));
      expect(await membership.userGroups(tx, id['ana'] ?? '')).toEqual([]);
    });
  });

  it('follows the hierarchy: moving a unit changes who a subtree group contains', async () => {
    await inTenant(TENANT, async (tx) => {
      await tx.prisma.orgUnit.update({
        where: { tenantId_id: { tenantId: TENANT, id: id['emea'] ?? '' } },
        data: { parentId: id['ceo'] ?? null },
      });
      expect(await membership.groupUsers(tx, id['subtree'] ?? '')).toEqual(sorted('ben'));
      await tx.prisma.orgUnit.update({
        where: { tenantId_id: { tenantId: TENANT, id: id['emea'] ?? '' } },
        data: { parentId: id['sales'] ?? null },
      });
    });
  });

  it('rejects a group containing itself, directly or through nesting', async () => {
    for (const [groupId, memberGroupId] of [
      ['outer', 'outer'],
      ['direct', 'outer'],
    ] as const) {
      await expect(
        inTenant(TENANT, ({ prisma: tx }) =>
          tx.groupMember.create({
            data: {
              tenantId: TENANT,
              groupId: id[groupId] ?? '',
              memberType: 'GROUP',
              memberGroupId: id[memberGroupId] ?? '',
            },
          }),
        ),
      ).rejects.toThrow(/cannot contain itself/);
    }
  });

  it('requires the target that matches the member type', async () => {
    const bad = [
      { memberType: 'USER' as const, orgUnitId: id['ceo'] },
      { memberType: 'GROUP' as const, userId: id['ana'] },
      { memberType: 'ORG_UNIT' as const, userId: id['ana'] },
      { memberType: 'USER' as const, userId: id['ana'], orgUnitId: id['ceo'] },
    ];
    for (const data of bad)
      await expect(
        inTenant(TENANT, ({ prisma: tx }) =>
          tx.groupMember.create({
            data: { tenantId: TENANT, groupId: id['direct'] ?? '', ...data },
          }),
        ),
        data.memberType,
      ).rejects.toThrow(/group_member_target/);
  });
});

describe('queues (§6.3)', () => {
  it('expand members like groups, list supported objects, and resolve a user’s queues', async () => {
    await inTenant(TENANT, async (tx) => {
      const { prisma: p } = tx;
      const q = await p.queue.create({
        data: {
          tenantId: TENANT,
          name: 'Inbound leads',
          email: 'inbound@grp.test',
        },
      });
      await p.queueObject.create({ data: { tenantId: TENANT, queueId: q.id, object: 'lead' } });
      const other = await p.queue.create({ data: { tenantId: TENANT, name: 'Escalations' } });
      await p.queueMember.createMany({
        data: [
          { tenantId: TENANT, queueId: q.id, memberType: 'USER', userId: id['ana'] ?? '' },
          {
            tenantId: TENANT,
            queueId: q.id,
            memberType: 'GROUP',
            memberGroupId: id['direct'] ?? '',
          },
          {
            tenantId: TENANT,
            queueId: other.id,
            memberType: 'ORG_UNIT_AND_SUBORDINATES',
            orgUnitId: id['sales'] ?? '',
          },
          {
            tenantId: TENANT,
            queueId: other.id,
            memberType: 'ORG_UNIT',
            orgUnitId: id['ceo'] ?? '',
          },
        ],
      });
      expect(await membership.queueUsers(tx, q.id)).toEqual(sorted('ana', 'dee'));
      expect(await membership.queueUsers(tx, other.id)).toEqual(sorted('ana', 'ben', 'cai'));
      expect(await membership.userQueues(tx, id['ana'] ?? '')).toEqual([q.id, other.id].sort());
      expect(await membership.userQueues(tx, id['dee'] ?? '')).toEqual([q.id]);
      expect(await membership.userQueues(tx, id['cai'] ?? '')).toEqual([other.id]);
      expect(await p.queueObject.findMany({ where: { queueId: q.id } })).toEqual([
        { tenantId: TENANT, queueId: q.id, object: 'lead' },
      ]);
    });
  });

  it('bumps perm_version when membership changes', async () => {
    const version = () =>
      inTenant(TENANT, async ({ prisma: tx }) => {
        const s = await tx.tenantSettings.findUniqueOrThrow({ where: { tenantId: TENANT } });
        return s.permVersion;
      });
    const before = await version();
    await inTenant(TENANT, ({ prisma: tx }) =>
      tx.groupMember.deleteMany({ where: { groupId: id['direct'] ?? '' } }),
    );
    const afterGroup = await version();
    await inTenant(TENANT, ({ prisma: tx }) =>
      tx.queueMember.deleteMany({ where: { userId: id['ana'] ?? '' } }),
    );
    expect(afterGroup).toBeGreaterThan(before);
    expect(await version()).toBeGreaterThan(afterGroup);
  });

  it('keeps groups, queues and their expansion inside the tenant', async () => {
    await inTenant(OTHER, async (tx) => {
      expect(await tx.prisma.publicGroup.count()).toBe(0);
      expect(await tx.prisma.queue.count()).toBe(0);
      expect(await membership.groupUsers(tx, id['outer'] ?? '')).toEqual([]);
      expect(await membership.userGroups(tx, id['ben'] ?? '')).toEqual([]);
    });
  });
});
