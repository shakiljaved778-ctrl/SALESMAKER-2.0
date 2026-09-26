import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createCellPrisma, disposeCellPrisma, type CellPrisma } from '../src/client.js';
import { withTenant, type TenantTransaction } from '../src/tenant.js';
import { createTestCellDatabase, type TestCellDatabase } from '../src/testing/cell-database.js';

const TENANT_A = '01920000-0000-7000-8000-0000000000a1';
const TENANT_B = '01920000-0000-7000-8000-0000000000b1';

let db: TestCellDatabase;
let prisma: CellPrisma;

type Tx = TenantTransaction['prisma'];

const inTenant = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(prisma, { tenantId }, ({ prisma: tx }) => fn(tx));

async function unit(tx: Tx, tenantId: string, name: string, parentId?: string) {
  const row = await tx.orgUnit.create({ data: { tenantId, name, parentId: parentId ?? null } });
  return row.id;
}

/** The closure as a set of "ancestor>descendant@depth" strings, for readable comparisons. */
async function closure(tx: Tx): Promise<string[]> {
  const units = await tx.orgUnit.findMany({ select: { id: true, name: true } });
  const name = new Map(units.map((u) => [u.id, u.name]));
  const rows = await tx.orgUnitClosure.findMany();
  return rows
    .map(
      (r) =>
        `${name.get(r.ancestorId) ?? '?'}>${name.get(r.descendantId) ?? '?'}@${String(r.depth)}`,
    )
    .sort();
}

/** The closure recomputed from parent pointers alone: what the triggers must maintain. */
async function expectedClosure(tx: Tx): Promise<string[]> {
  const units = await tx.orgUnit.findMany({ select: { id: true, name: true, parentId: true } });
  const byId = new Map(units.map((u) => [u.id, u]));
  const out: string[] = [];
  for (const u of units) {
    let depth = 0;
    for (let a: (typeof units)[number] | undefined = u; a; a = byId.get(a.parentId ?? '')) {
      out.push(`${a.name}>${u.name}@${String(depth)}`);
      depth += 1;
    }
  }
  return out.sort();
}

beforeAll(async () => {
  db = await createTestCellDatabase(inject('pgServerAdminUrl'));
  prisma = createCellPrisma(db.appUrl);
  for (const [tenantId, slug] of [
    [TENANT_A, 'hier-a'],
    [TENANT_B, 'hier-b'],
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
});

afterAll(async () => {
  await disposeCellPrisma(prisma);
  await db.drop();
});

describe('org_unit_closure (§6.3, §6.4)', () => {
  it('records every ancestor path, including each unit itself at depth 0', async () => {
    await inTenant(TENANT_A, async (tx) => {
      const ceo = await unit(tx, TENANT_A, 'ceo');
      const sales = await unit(tx, TENANT_A, 'sales', ceo);
      await unit(tx, TENANT_A, 'emea', sales);
      await unit(tx, TENANT_A, 'ops', ceo);
      expect(await closure(tx)).toEqual([
        'ceo>ceo@0',
        'ceo>emea@2',
        'ceo>ops@1',
        'ceo>sales@1',
        'emea>emea@0',
        'ops>ops@0',
        'sales>emea@1',
        'sales>sales@0',
      ]);
    });
  });

  it('moves a whole subtree and rewrites only the paths that cross the move', async () => {
    await inTenant(TENANT_A, async (tx) => {
      const [sales, ops] = await Promise.all([
        tx.orgUnit.findFirstOrThrow({ where: { name: 'sales' } }),
        tx.orgUnit.findFirstOrThrow({ where: { name: 'ops' } }),
      ]);
      await tx.orgUnit.update({
        where: { tenantId_id: { tenantId: TENANT_A, id: sales.id } },
        data: { parentId: ops.id },
      });
      expect(await closure(tx)).toEqual(await expectedClosure(tx));
      expect(await closure(tx)).toContain('ops>emea@2');
      expect(await closure(tx)).toContain('ceo>emea@3');
      // Moving to the top level detaches it from every old ancestor.
      await tx.orgUnit.update({
        where: { tenantId_id: { tenantId: TENANT_A, id: sales.id } },
        data: { parentId: null },
      });
      expect(await closure(tx)).toEqual(await expectedClosure(tx));
      expect(await closure(tx)).not.toContain('ceo>emea@3');
      // A rename is not a move and leaves the closure untouched.
      const before = await closure(tx);
      await tx.orgUnit.update({
        where: { tenantId_id: { tenantId: TENANT_A, id: ops.id } },
        data: { name: 'ops' },
      });
      expect(await closure(tx)).toEqual(before);
    });
  });

  it('rejects moving a unit under itself or its own subtree', async () => {
    await expect(
      inTenant(TENANT_A, async (tx) => {
        const ceo = await tx.orgUnit.findFirstOrThrow({ where: { name: 'ceo' } });
        const ops = await tx.orgUnit.findFirstOrThrow({ where: { name: 'ops' } });
        await tx.orgUnit.update({
          where: { tenantId_id: { tenantId: TENANT_A, id: ceo.id } },
          data: { parentId: ops.id },
        });
      }),
    ).rejects.toThrow(/own subtree/);
    await expect(
      inTenant(TENANT_A, async (tx) => {
        const ceo = await tx.orgUnit.findFirstOrThrow({ where: { name: 'ceo' } });
        await tx.orgUnit.update({
          where: { tenantId_id: { tenantId: TENANT_A, id: ceo.id } },
          data: { parentId: ceo.id },
        });
      }),
    ).rejects.toThrow(/org_unit_not_own_parent|own subtree/);
  });

  it('stays consistent through a random sequence of inserts and moves', async () => {
    // Deterministic pseudo-random walk (LCG) so a failure reproduces.
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed % n;
    };
    await inTenant(TENANT_A, async (tx) => {
      const ids: string[] = [];
      for (let i = 0; i < 25; i += 1)
        ids.push(
          await unit(tx, TENANT_A, `r${String(i)}`, i && rand(4) ? ids[rand(i)] : undefined),
        );
      for (let step = 0; step < 40; step += 1) {
        const id = ids[rand(ids.length)] ?? '';
        const target = rand(5) === 0 ? null : (ids[rand(ids.length)] ?? null);
        const cyclic =
          target !== null &&
          (await tx.orgUnitClosure.count({ where: { ancestorId: id, descendantId: target } })) > 0;
        if (cyclic) continue; // covered above; a failed statement would abort the transaction
        await tx.orgUnit.update({
          where: { tenantId_id: { tenantId: TENANT_A, id } },
          data: { parentId: target },
        });
      }
      expect(await closure(tx)).toEqual(await expectedClosure(tx));
    });
  });

  it('cascades closure rows when a leaf is deleted and refuses to delete a parent', async () => {
    await inTenant(TENANT_A, async (tx) => {
      const leaf = await unit(
        tx,
        TENANT_A,
        'leaf',
        (await tx.orgUnit.findFirstOrThrow({ where: { name: 'ceo' } })).id,
      );
      await tx.orgUnit.delete({ where: { tenantId_id: { tenantId: TENANT_A, id: leaf } } });
      expect(await tx.orgUnitClosure.count({ where: { descendantId: leaf } })).toBe(0);
    });
    await expect(
      inTenant(TENANT_A, async (tx) => {
        const ceo = await tx.orgUnit.findFirstOrThrow({ where: { name: 'ceo' } });
        await tx.orgUnit.delete({ where: { tenantId_id: { tenantId: TENANT_A, id: ceo.id } } });
      }),
    ).rejects.toThrow();
  });

  it('is written only by the triggers: the runtime role cannot touch it directly', async () => {
    const client = new pg.Client({ connectionString: db.appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM org_unit LIMIT 1`);
      await expect(
        client.query(
          `INSERT INTO org_unit_closure (tenant_id, ancestor_id, descendant_id, depth) VALUES ($1, $2, $2, 5)`,
          [TENANT_A, rows[0]?.id],
        ),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('keeps each tenant to its own hierarchy (RLS)', async () => {
    await inTenant(TENANT_B, async (tx) => {
      await unit(tx, TENANT_B, 'b-root');
      expect(await closure(tx)).toEqual(['b-root>b-root@0']);
      expect(await tx.orgUnit.count()).toBe(1);
    });
    // A tenant cannot parent a unit under another tenant's unit: the FK is (tenant_id, id).
    const foreign = await inTenant(TENANT_A, (tx) =>
      tx.orgUnit.findFirstOrThrow({ where: { name: 'ceo' } }),
    );
    await expect(
      inTenant(TENANT_B, (tx) => unit(tx, TENANT_B, 'sneaky', foreign.id)),
    ).rejects.toThrow();
  });
});

describe('user placement and manager chain', () => {
  const user = (tx: Tx, email: string, extra: { managerId?: string; orgUnitId?: string } = {}) =>
    tx.user.create({ data: { tenantId: TENANT_A, email, name: email, ...extra } });

  it('places users in org units and under managers', async () => {
    await inTenant(TENANT_A, async (tx) => {
      const ceoUnit = await tx.orgUnit.findFirstOrThrow({ where: { name: 'ceo' } });
      const boss = await user(tx, 'boss@a.test', { orgUnitId: ceoUnit.id });
      const rep = await user(tx, 'rep@a.test', { managerId: boss.id, orgUnitId: ceoUnit.id });
      const reports = await tx.user.findMany({ where: { managerId: boss.id } });
      expect(reports.map((r) => r.id)).toEqual([rep.id]);
      await tx.user.update({
        where: { tenantId_id: { tenantId: TENANT_A, id: rep.id } },
        data: {
          title: 'AE',
          department: 'Sales',
          phone: '+44 20 7946 0000',
          deactivatedAt: new Date(),
        },
      });
    });
  });

  it('rejects a manager cycle, direct or indirect', async () => {
    const ids = await inTenant(TENANT_A, async (tx) => {
      const a = await user(tx, 'a@chain.test');
      const b = await user(tx, 'b@chain.test', { managerId: a.id });
      const c = await user(tx, 'c@chain.test', { managerId: b.id });
      return { a: a.id, c: c.id };
    });
    await expect(
      inTenant(TENANT_A, (tx) =>
        tx.user.update({
          where: { tenantId_id: { tenantId: TENANT_A, id: ids.a } },
          data: { managerId: ids.c },
        }),
      ),
    ).rejects.toThrow(/own report/);
    await expect(
      inTenant(TENANT_A, (tx) =>
        tx.user.update({
          where: { tenantId_id: { tenantId: TENANT_A, id: ids.a } },
          data: { managerId: ids.a },
        }),
      ),
    ).rejects.toThrow(/own report|user_not_own_manager/);
    // Re-pointing to a non-cyclic manager is fine, and clearing it always is.
    await inTenant(TENANT_A, async (tx) => {
      await tx.user.update({
        where: { tenantId_id: { tenantId: TENANT_A, id: ids.c } },
        data: { managerId: ids.a },
      });
      await tx.user.update({
        where: { tenantId_id: { tenantId: TENANT_A, id: ids.c } },
        data: { managerId: null },
      });
    });
  });

  it('refuses to delete an org unit that still has users', async () => {
    await expect(
      inTenant(TENANT_A, async (tx) => {
        const u = await tx.user.findFirstOrThrow({ where: { email: 'rep@a.test' } });
        const leaf = await unit(tx, TENANT_A, 'staffed');
        await tx.user.update({
          where: { tenantId_id: { tenantId: TENANT_A, id: u.id } },
          data: { orgUnitId: leaf },
        });
        await tx.orgUnit.delete({ where: { tenantId_id: { tenantId: TENANT_A, id: leaf } } });
      }),
    ).rejects.toThrow();
  });
});
