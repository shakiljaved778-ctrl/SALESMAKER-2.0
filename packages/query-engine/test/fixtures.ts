import { createCellPrisma, disposeCellPrisma, withTenant, type CellPrisma } from '@sm/db';
import type { TenantTransaction } from '@sm/db';
import { createTestCellDatabase, type TestCellDatabase } from '@sm/db/testing';
import pg from 'pg';
import { inject } from 'vitest';

/**
 * A fresh cell database with fixture "object" tables (standard CRM tables arrive in P02): each has
 * tenant_id, id, owner_id like every CRM table (§4.1), with forced RLS.
 */
export interface Fixture {
  db: TestCellDatabase;
  prisma: CellPrisma;
  inTenant<T>(tenantId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}

const TABLES = `
CREATE TABLE fx_account (tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT uuid_generate_v7(),
  owner_id uuid NOT NULL, name text NOT NULL, amount numeric(18,2), closed_on date,
  active boolean, parent_id uuid, PRIMARY KEY (tenant_id, id));
CREATE TABLE fx_contact (tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT uuid_generate_v7(),
  owner_id uuid NOT NULL, name text NOT NULL, account_id uuid, PRIMARY KEY (tenant_id, id));
CREATE TABLE fx_activity (tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT uuid_generate_v7(),
  owner_id uuid NOT NULL, name text NOT NULL, what_id uuid, who_id uuid, PRIMARY KEY (tenant_id, id));
SELECT enable_tenant_rls('fx_account');
SELECT enable_tenant_rls('fx_contact');
SELECT enable_tenant_rls('fx_activity');
`;

export async function createFixture(): Promise<Fixture> {
  const db = await createTestCellDatabase(inject('pgServerAdminUrl'));
  const migrator = new pg.Client({ connectionString: db.migratorUrl });
  await migrator.connect();
  await migrator.query(TABLES);
  await migrator.end();
  const prisma = createCellPrisma(db.appUrl);
  return {
    db,
    prisma,
    inTenant: (tenantId, fn) => withTenant(prisma, { tenantId }, fn),
    async dispose() {
      await disposeCellPrisma(prisma);
      await db.drop();
    },
  };
}

export async function seedTenantSettings(f: Fixture, tenantId: string, slug: string) {
  await f.inTenant(tenantId, ({ prisma }) =>
    prisma.tenantSettings.create({
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
