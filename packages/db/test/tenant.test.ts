import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createCellPrisma, disposeCellPrisma, type CellPrisma } from '../src/client.js';
import { InvalidTenantContextError, withTenant } from '../src/tenant.js';
import { createTestCellDatabase, type TestCellDatabase } from '../src/testing/cell-database.js';

const TENANT_A = '01920000-0000-7000-8000-00000000000a';
const TENANT_B = '01920000-0000-7000-8000-00000000000b';

let db: TestCellDatabase;
let prisma: CellPrisma;

async function seedTenant(tenantId: string, slug: string) {
  await withTenant(prisma, { tenantId }, async ({ prisma: tx }) => {
    await tx.tenantSettings.create({
      data: {
        tenantId,
        name: slug,
        slug,
        region: 'eu-central-1',
        corporateCurrency: 'USD',
        defaultTimezone: 'UTC',
      },
    });
    await tx.user.create({
      data: { tenantId, email: `owner@${slug}.test`, name: `${slug} owner` },
    });
  });
}

beforeAll(async () => {
  db = await createTestCellDatabase(inject('pgServerAdminUrl'));
  prisma = createCellPrisma(db.appUrl);
  await seedTenant(TENANT_A, 'alpha');
  await seedTenant(TENANT_B, 'bravo');
});

afterAll(async () => {
  await disposeCellPrisma(prisma);
  await db.drop();
});

describe('withTenant isolation (golden rule 1, §3.5)', () => {
  it('shows each tenant only its own rows through Prisma', async () => {
    const emails = await withTenant(prisma, { tenantId: TENANT_A }, ({ prisma: tx }) =>
      tx.user.findMany({ select: { email: true } }),
    );
    expect(emails).toEqual([{ email: 'owner@alpha.test' }]);
  });

  it('shows each tenant only its own rows through Kysely on the same transaction', async () => {
    const rows = await withTenant(prisma, { tenantId: TENANT_B }, ({ kysely }) =>
      kysely.selectFrom('user').select(['email', 'tenant_id']).execute(),
    );
    expect(rows).toEqual([{ email: 'owner@bravo.test', tenant_id: TENANT_B }]);
  });

  it('rejects writes that carry another tenant id (WITH CHECK)', async () => {
    await expect(
      withTenant(prisma, { tenantId: TENANT_A }, ({ prisma: tx }) =>
        tx.user.create({
          data: { tenantId: TENANT_B, email: 'intruder@bravo.test', name: 'Intruder' },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot update or delete another tenant’s rows', async () => {
    const result = await withTenant(prisma, { tenantId: TENANT_A }, async ({ kysely }) => {
      const updated = await kysely
        .updateTable('user')
        .set({ name: 'hijacked' })
        .where('tenant_id', '=', TENANT_B)
        .executeTakeFirst();
      const deleted = await kysely
        .deleteFrom('user')
        .where('tenant_id', '=', TENANT_B)
        .executeTakeFirst();
      return { updated: updated.numUpdatedRows, deleted: deleted.numDeletedRows };
    });
    expect(result).toEqual({ updated: 0n, deleted: 0n });
    const bravo = await withTenant(prisma, { tenantId: TENANT_B }, ({ prisma: tx }) =>
      tx.user.findMany({ select: { name: true } }),
    );
    expect(bravo).toEqual([{ name: 'bravo owner' }]);
  });

  it('exposes the tenant and user to SQL as transaction-local settings', async () => {
    const userId = '01920000-0000-7000-8000-0000000000ff';
    const settings = await withTenant(
      prisma,
      { tenantId: TENANT_A, userId },
      async ({ kysely }) => {
        const { rows } = await sql<{ tenant: string; user: string; timeout: string }>`
        SELECT current_setting('app.tenant_id') AS tenant, current_setting('app.user_id') AS user,
               current_setting('statement_timeout') AS timeout`.execute(kysely);
        return rows[0];
      },
    );
    expect(settings).toEqual({ tenant: TENANT_A, user: userId, timeout: '5s' });
  });

  it('commits or rolls back Prisma and Kysely writes together', async () => {
    await expect(
      withTenant(prisma, { tenantId: TENANT_A }, async ({ prisma: tx, kysely }) => {
        await kysely
          .insertInto('user')
          .values({ tenant_id: TENANT_A, email: 'rollback@alpha.test', name: 'Rollback' })
          .execute();
        const seenByPrisma = await tx.user.count({ where: { email: 'rollback@alpha.test' } });
        expect(seenByPrisma).toBe(1);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const after = await withTenant(prisma, { tenantId: TENANT_A }, ({ prisma: tx }) =>
      tx.user.count({ where: { email: 'rollback@alpha.test' } }),
    );
    expect(after).toBe(0);
  });

  it('leaves no tenant setting behind on the pooled connection afterwards', async () => {
    await withTenant(prisma, { tenantId: TENANT_A }, ({ prisma: tx }) => tx.user.count());
    const [row] = await prisma.$queryRaw<{ tenant: string | null; users: bigint }[]>`
      SELECT current_setting('app.tenant_id', true) AS tenant, (SELECT count(*) FROM "user") AS users`;
    expect(row?.tenant ?? '').toBe('');
    expect(row?.users).toBe(0n);
  });

  it('keeps tenants apart under concurrent transactions on a small pool', async () => {
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) => {
        const tenantId = i % 2 === 0 ? TENANT_A : TENANT_B;
        return withTenant(prisma, { tenantId }, async ({ kysely }) => {
          const rows = await kysely.selectFrom('user').select('tenant_id').execute();
          return rows.every((r) => r['tenant_id'] === tenantId) && rows.length > 0;
        });
      }),
    );
    expect(results.every(Boolean)).toBe(true);
  });

  it('refuses a malformed tenant or user id before touching the database', async () => {
    await expect(
      withTenant(prisma, { tenantId: "x' OR 1=1 --" }, () => Promise.resolve(1)),
    ).rejects.toBeInstanceOf(InvalidTenantContextError);
    await expect(
      withTenant(prisma, { tenantId: TENANT_A, userId: 'nope' }, () => Promise.resolve(1)),
    ).rejects.toBeInstanceOf(InvalidTenantContextError);
  });

  it('does not let Kysely open or end its own transaction', async () => {
    await expect(
      withTenant(prisma, { tenantId: TENANT_A }, ({ kysely }) =>
        kysely.transaction().execute(() => Promise.resolve(1)),
      ),
    ).rejects.toThrow(/withTenant/);
  });
});
