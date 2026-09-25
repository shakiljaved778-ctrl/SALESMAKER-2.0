import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditRowLevelSecurity } from '../src/rls-audit.js';
import { createTestCellDatabase, type TestCellDatabase } from '../src/testing/cell-database.js';

let db: TestCellDatabase;
let migrator: pg.Client;

beforeAll(async () => {
  db = await createTestCellDatabase(inject('pgServerAdminUrl'));
  migrator = new pg.Client({ connectionString: db.migratorUrl });
  await migrator.connect();
});

afterAll(async () => {
  await migrator.end();
  await db.drop();
});

describe('db:rls-audit (§3.5)', () => {
  it('passes on the migrated cell schema', async () => {
    expect(await auditRowLevelSecurity(migrator)).toEqual([]);
  });

  it('flags a tenant table without RLS', async () => {
    await migrator.query('CREATE TABLE fixture_no_rls (tenant_id uuid NOT NULL, id uuid NOT NULL)');
    const violations = await auditRowLevelSecurity(migrator);
    expect(violations).toEqual(
      expect.arrayContaining([
        { table: 'public.fixture_no_rls', problem: 'row level security is not enabled' },
        {
          table: 'public.fixture_no_rls',
          problem: 'row level security is not forced (owner would bypass it)',
        },
        { table: 'public.fixture_no_rls', problem: 'missing tenant_isolation policy' },
      ]),
    );
    await migrator.query('DROP TABLE fixture_no_rls');
  });

  it('flags RLS that is enabled but not forced', async () => {
    await migrator.query('CREATE TABLE fixture_not_forced (tenant_id uuid NOT NULL)');
    await migrator.query("SELECT enable_tenant_rls('fixture_not_forced')");
    await migrator.query('ALTER TABLE fixture_not_forced NO FORCE ROW LEVEL SECURITY');
    expect(await auditRowLevelSecurity(migrator)).toEqual([
      {
        table: 'public.fixture_not_forced',
        problem: 'row level security is not forced (owner would bypass it)',
      },
    ]);
    await migrator.query('DROP TABLE fixture_not_forced');
  });

  it('flags an extra permissive policy that would widen access', async () => {
    await migrator.query('CREATE TABLE fixture_extra (tenant_id uuid NOT NULL)');
    await migrator.query("SELECT enable_tenant_rls('fixture_extra')");
    await migrator.query('CREATE POLICY everyone ON fixture_extra FOR SELECT USING (true)');
    expect(await auditRowLevelSecurity(migrator)).toEqual([
      {
        table: 'public.fixture_extra',
        problem: 'extra permissive policy "everyone" could widen tenant access',
      },
    ]);
    await migrator.query('DROP TABLE fixture_extra');
  });

  it('flags a tenant_isolation policy with the wrong predicate', async () => {
    await migrator.query('CREATE TABLE fixture_weak (tenant_id uuid NOT NULL)');
    await migrator.query('ALTER TABLE fixture_weak ENABLE ROW LEVEL SECURITY');
    await migrator.query('ALTER TABLE fixture_weak FORCE ROW LEVEL SECURITY');
    await migrator.query('CREATE POLICY tenant_isolation ON fixture_weak USING (true)');
    const problems = (await auditRowLevelSecurity(migrator)).map((v) => v.problem);
    expect(problems).toEqual([
      'tenant_isolation USING is not tenant_id = app_current_tenant_id()',
      'tenant_isolation WITH CHECK is not tenant_id = app_current_tenant_id()',
    ]);
    await migrator.query('DROP TABLE fixture_weak');
  });

  it('honours an explicit allow-list', async () => {
    await migrator.query('CREATE TABLE fixture_allowed (tenant_id uuid NOT NULL)');
    expect(await auditRowLevelSecurity(migrator, ['public.fixture_allowed'])).toEqual([]);
    await migrator.query('DROP TABLE fixture_allowed');
  });
});
