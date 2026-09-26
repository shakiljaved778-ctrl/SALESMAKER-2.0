import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createCellPrisma, disposeCellPrisma, type CellPrisma } from '../src/client.js';
import { principalsOf, visibility } from '../src/sharing.js';
import { withTenant, type TenantTransaction } from '../src/tenant.js';
import { createTestCellDatabase, type TestCellDatabase } from '../src/testing/cell-database.js';

const TENANT = '01920000-0000-7000-8000-0000000000f1';
const OTHER = '01920000-0000-7000-8000-0000000000f2';

let db: TestCellDatabase;
let prisma: CellPrisma;

const inTenant = <T>(tenantId: string, fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(prisma, { tenantId }, fn);

// Org: ceo > sales > (emea, apac);  users: cara (ceo), sam (sales), eve (emea), abe (apac),
// flo (no unit, reports to sam). Queue "inbound" has eve.
const id: Record<string, string> = {};
const ids = (...names: string[]) => names.map((n) => id[n] ?? n).sort();

beforeAll(async () => {
  db = await createTestCellDatabase(inject('pgServerAdminUrl'));
  prisma = createCellPrisma(db.appUrl);
  for (const [tenantId, slug] of [
    [TENANT, 'share-a'],
    [OTHER, 'share-b'],
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
    for (const [name, parent] of [
      ['ceo', null],
      ['sales', 'ceo'],
      ['emea', 'sales'],
      ['apac', 'sales'],
    ] as const) {
      const u = await tx.orgUnit.create({
        data: { tenantId: TENANT, name, parentId: parent ? (id[parent] ?? null) : null },
      });
      id[name] = u.id;
    }
    for (const [name, unit] of [
      ['cara', 'ceo'],
      ['sam', 'sales'],
      ['eve', 'emea'],
      ['abe', 'apac'],
      ['flo', null],
    ] as const) {
      const u = await tx.user.create({
        data: {
          tenantId: TENANT,
          email: `${name}@share.test`,
          name,
          orgUnitId: unit ? (id[unit] ?? null) : null,
        },
      });
      id[name] = u.id;
    }
    await tx.user.update({
      where: { tenantId_id: { tenantId: TENANT, id: id['flo'] ?? '' } },
      data: { managerId: id['sam'] ?? null },
    });
    const q = await tx.queue.create({ data: { tenantId: TENANT, name: 'inbound' } });
    id['inbound'] = q.id;
    await tx.queueMember.create({
      data: { tenantId: TENANT, queueId: q.id, memberType: 'USER', userId: id['eve'] ?? '' },
    });
  });
});

afterAll(async () => {
  await disposeCellPrisma(prisma);
  await db.drop();
});

describe('user_visibility_closure (§6.4)', () => {
  it('lets each viewer see themselves, lower org units, direct reports and their queues', async () => {
    await inTenant(TENANT, async (tx) => {
      expect(await visibility.rebuild(tx)).toBeGreaterThan(0);
      expect(await visibility.ownersVisibleTo(tx, id['cara'] ?? '')).toEqual(
        ids('cara', 'sam', 'eve', 'abe'),
      );
      expect(await visibility.ownersVisibleTo(tx, id['sam'] ?? '')).toEqual(
        ids('sam', 'eve', 'abe', 'flo'),
      );
      expect(await visibility.ownersVisibleTo(tx, id['eve'] ?? '')).toEqual(ids('eve', 'inbound'));
      expect(await visibility.ownersVisibleTo(tx, id['abe'] ?? '')).toEqual(ids('abe'));
    });
  });

  it('does not let peers in the same org unit see each other', async () => {
    await inTenant(TENANT, async (tx) => {
      const peer = await tx.prisma.user.create({
        data: {
          tenantId: TENANT,
          email: 'peer@share.test',
          name: 'peer',
          orgUnitId: id['emea'] ?? null,
        },
      });
      id['peer'] = peer.id;
      await visibility.rebuild(tx, [
        peer.id,
        ...(await visibility.viewersAbove(tx, [id['emea'] ?? ''])),
      ]);
      expect(await visibility.ownersVisibleTo(tx, id['eve'] ?? '')).not.toContain(peer.id);
      expect(await visibility.ownersVisibleTo(tx, peer.id)).toEqual([peer.id]);
      expect(await visibility.ownersVisibleTo(tx, id['cara'] ?? '')).toContain(peer.id);
    });
  });

  it('rebuilds only the viewers asked for, and follows a subtree move', async () => {
    await inTenant(TENANT, async (tx) => {
      // Move apac under ceo directly: sam no longer sees abe; cara still does.
      await tx.prisma.orgUnit.update({
        where: { tenantId_id: { tenantId: TENANT, id: id['apac'] ?? '' } },
        data: { parentId: id['ceo'] ?? null },
      });
      expect(await visibility.ownersVisibleTo(tx, id['sam'] ?? '')).toContain(id['abe']); // stale
      const affected = await visibility.viewersAbove(tx, [id['sales'] ?? '', id['apac'] ?? '']);
      expect(affected).toEqual(ids('cara'));
      await visibility.rebuild(tx, [...affected, id['sam'] ?? '']);
      expect(await visibility.ownersVisibleTo(tx, id['sam'] ?? '')).not.toContain(id['abe']);
      expect(await visibility.ownersVisibleTo(tx, id['cara'] ?? '')).toContain(id['abe']);
    });
    expect(await inTenant(TENANT, (tx) => visibility.viewersAbove(tx, []))).toEqual([]);
  });

  it('is written only by the rebuild function and needs a tenant', async () => {
    const client = new pg.Client({ connectionString: db.appUrl });
    await client.connect();
    try {
      await expect(client.query(`SELECT rebuild_user_visibility()`)).rejects.toThrow(
        /tenant transaction/,
      );
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);
      await expect(
        client.query(
          `INSERT INTO user_visibility_closure (tenant_id, viewer_user_id, owner_id) VALUES ($1, $2, $2)`,
          [TENANT, id['abe']],
        ),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('stays inside the tenant', async () => {
    await inTenant(OTHER, async (tx) => {
      expect(await visibility.rebuild(tx)).toBe(0);
      expect(await tx.prisma.userVisibilityClosure.count()).toBe(0);
      expect(await visibility.ownersVisibleTo(tx, id['cara'] ?? '')).toEqual([]);
    });
  });
});

describe('principalsOf (§6.4)', () => {
  it('lists the user, transitive groups, queues, their unit and its ancestors', async () => {
    await inTenant(TENANT, async (tx) => {
      const g = await tx.prisma.publicGroup.create({ data: { tenantId: TENANT, name: 'EMEA' } });
      await tx.prisma.groupMember.create({
        data: {
          tenantId: TENANT,
          groupId: g.id,
          memberType: 'ORG_UNIT',
          orgUnitId: id['emea'] ?? '',
        },
      });
      expect(await principalsOf(tx, id['eve'] ?? '')).toEqual({
        userId: id['eve'],
        groupIds: [g.id],
        queueIds: [id['inbound']],
        orgUnitId: id['emea'],
        orgUnitAndAncestors: ids('emea', 'sales', 'ceo'),
      });
      expect(await principalsOf(tx, id['flo'] ?? '')).toEqual({
        userId: id['flo'],
        groupIds: [],
        queueIds: [],
        orgUnitId: null,
        orgUnitAndAncestors: [],
      });
    });
  });

  it('bumps perm_version when an org-wide default changes', async () => {
    const version = () =>
      inTenant(
        TENANT,
        async ({ prisma: tx }) =>
          (await tx.tenantSettings.findUniqueOrThrow({ where: { tenantId: TENANT } })).permVersion,
      );
    const before = await version();
    await inTenant(TENANT, ({ prisma: tx }) =>
      tx.orgWideDefault.create({
        data: { tenantId: TENANT, object: 'lead', sharingModel: 'PUBLIC_READ' },
      }),
    );
    expect(await version()).toBeGreaterThan(before);
  });
});
