import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createTestCellDatabase, type TestCellDatabase } from '../src/testing/cell-database.js';

let db: TestCellDatabase;
let admin: pg.Client;

beforeAll(async () => {
  db = await createTestCellDatabase(inject('pgServerAdminUrl'));
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await db.drop();
});

async function asRole<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe('cell roles (§3.5)', () => {
  it('creates the runtime and reporting roles without BYPASSRLS or superuser', async () => {
    const { rows } = await admin.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }>(
      `SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles
       WHERE rolname IN ('sm_migrator','sm_app','sm_readonly_reports','sm_support') ORDER BY rolname`,
    );
    expect(rows.map((r) => r.rolname)).toEqual([
      'sm_app',
      'sm_migrator',
      'sm_readonly_reports',
      'sm_support',
    ]);
    for (const r of rows) {
      expect(r.rolsuper).toBe(false);
      expect(r.rolbypassrls).toBe(false);
    }
    expect(rows.find((r) => r.rolname === 'sm_support')?.rolcanlogin).toBe(false);
  });

  it('makes sm_migrator the owner of every table, never sm_app', async () => {
    const { rows } = await admin.query<{ owner: string }>(
      `SELECT DISTINCT pg_get_userbyid(relowner) AS owner FROM pg_class
       WHERE relkind IN ('r','p') AND relnamespace = 'public'::regnamespace`,
    );
    expect(rows).toEqual([{ owner: 'sm_migrator' }]);
  });

  it('denies DDL to sm_app', async () => {
    await expect(asRole(db.appUrl, (c) => c.query('CREATE TABLE sneaky (id int)'))).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('tenant tables (§3.5, §4.1)', () => {
  it('forces RLS with the tenant_isolation policy on every table that has tenant_id', async () => {
    const { rows } = await admin.query<{
      relname: string;
      forced: boolean;
      enabled: boolean;
      policies: number;
    }>(
      `SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public'
                 AND p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS policies
       FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
       WHERE c.relkind IN ('r','p') AND c.relnamespace = 'public'::regnamespace ORDER BY 1`,
    );
    expect(rows.length).toBe(10);
    for (const r of rows)
      expect(r, r.relname).toMatchObject({ enabled: true, forced: true, policies: 1 });
  });

  it('leads every primary key and index on tenant tables with tenant_id', async () => {
    const { rows } = await admin.query<{ index: string; first: string }>(
      `SELECT i.indexrelid::regclass::text AS index, a.attname AS first
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid AND c.relnamespace = 'public'::regnamespace
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
       WHERE EXISTS (SELECT 1 FROM pg_attribute t WHERE t.attrelid = c.oid AND t.attname = 'tenant_id')`,
    );
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) expect(r.first, r.index).toBe('tenant_id');
  });

  it('shows sm_app no rows when no tenant is set, even with data present', async () => {
    await admin.query(
      `INSERT INTO tenant_settings (tenant_id, name, slug, region, corporate_currency, default_timezone)
       VALUES (uuid_generate_v7(), 'Acme', 'acme', 'eu-central-1', 'USD', 'UTC')`,
    );
    const rows = await asRole(
      db.appUrl,
      async (c) =>
        (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM tenant_settings')).rows,
    );
    expect(rows).toEqual([{ n: 0 }]);
  });
});

describe('uuid_generate_v7 (§4.1)', () => {
  it('produces version-7, RFC 4122-variant, time-ordered ids', async () => {
    const { rows } = await admin.query<{ id: string }>(
      'SELECT uuid_generate_v7()::text AS id FROM generate_series(1, 50)',
    );
    for (const { id } of rows)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const first = rows[0]?.id ?? '';
    const msPrefix = Number.parseInt(first.replace(/-/g, '').slice(0, 12), 16);
    expect(Math.abs(msPrefix - Date.now())).toBeLessThan(60_000);
  });
});

describe('reference data', () => {
  it('seeds ISO 4217 currencies including the demo tenants’ QAR and USD', async () => {
    const { rows } = await admin.query<{ code: string }>(
      `SELECT code FROM currency WHERE code IN ('QAR','USD','EUR','AED','SAR','INR') ORDER BY 1`,
    );
    expect(rows.map((r) => r.code)).toEqual(['AED', 'EUR', 'INR', 'QAR', 'SAR', 'USD']);
  });
});
