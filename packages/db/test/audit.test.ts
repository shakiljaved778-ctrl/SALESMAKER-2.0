import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  audit,
  AUDIT_CHAIN_TOPIC,
  canonicalJson,
  chainHash,
  GENESIS,
  merkleRoot,
  type ChainedFields,
} from '../src/audit.js';
import { createCellPrisma, disposeCellPrisma, type CellPrisma } from '../src/client.js';
import { withTenant, type TenantTransaction } from '../src/tenant.js';
import { createTestCellDatabase, type TestCellDatabase } from '../src/testing/cell-database.js';

const A = '01920000-0000-7000-8000-000000000d01';
const B = '01920000-0000-7000-8000-000000000d02';
const USER = '01920000-0000-7000-8000-000000000d03';

let db: TestCellDatabase;
let app: CellPrisma;
let auditor: CellPrisma;
let admin: pg.Client;

const asApp = <T>(tenantId: string, fn: (tx: TenantTransaction) => Promise<T>, userId?: string) =>
  withTenant(app, { tenantId, ...(userId ? { userId } : {}) }, fn);
const chain = (tenantId: string, options: Parameters<typeof audit.chain>[1] = {}) =>
  audit.chain((fn) => withTenant(auditor, { tenantId }, fn), options);
const verify = (tenantId: string, options: Parameters<typeof audit.verify>[1] = {}) =>
  asApp(tenantId, (tx) => audit.verify(tx, options));
const later = () => new Date(Date.now() + 10 * 60_000);

beforeAll(async () => {
  db = await createTestCellDatabase(inject('pgServerAdminUrl'));
  app = createCellPrisma(db.appUrl);
  auditor = createCellPrisma(db.auditUrl);
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await disposeCellPrisma(app);
  await disposeCellPrisma(auditor);
  await db.drop();
});

describe('hash primitives', () => {
  it('canonicalises JSON with sorted keys at every level, dropping undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null }, e: undefined })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('chains hashes and builds Merkle roots deterministically', () => {
    const row = { id: 'x' } as unknown as ChainedFields;
    const h1 = chainHash(GENESIS, row);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(chainHash(GENESIS, row)).toBe(h1);
    expect(chainHash(h1, row)).not.toBe(h1);
    expect(merkleRoot([h1])).toBe(h1);
    const three = merkleRoot(['a', 'b', 'c']);
    expect(three).toMatch(/^[0-9a-f]{64}$/);
    expect(merkleRoot(['a', 'b', 'c', 'c'])).toBe(three); // an odd node pairs with itself
    expect(() => merkleRoot([])).toThrow();
  });
});

describe('audit.record', () => {
  it('numbers each tenant’s entries separately and asks for chaining', async () => {
    for (let i = 0; i < 3; i += 1)
      await asApp(
        A,
        (tx) => audit.record(tx, { action: 'record.updated', object: 'lead', payload: { i } }),
        USER,
      );
    await asApp(B, (tx) => audit.record(tx, { action: 'user.signed_in' }));
    const rows = await asApp(A, (tx) => tx.prisma.auditLog.findMany({ orderBy: { seq: 'asc' } }));
    expect(rows.map((r) => r.seq)).toEqual([1n, 2n, 3n]);
    expect(rows[0]).toMatchObject({ actorType: 'user', actorId: USER, hash: null });
    const other = await asApp(B, (tx) => tx.prisma.auditLog.findFirstOrThrow());
    expect(other).toMatchObject({ seq: 1n, actorType: 'system', actorId: null });
    expect(
      await asApp(A, (tx) => tx.prisma.outboxEvent.count({ where: { topic: AUDIT_CHAIN_TOPIC } })),
    ).toBe(3);
  });

  it('hands out unique numbers to concurrent transactions of a new tenant', async () => {
    const tenant = '01920000-0000-7000-8000-000000000d09';
    await Promise.all(
      Array.from({ length: 6 }, () =>
        asApp(tenant, (tx) => audit.record(tx, { action: 'x.y', actorType: 'agent' })),
      ),
    );
    const seqs = await asApp(tenant, (tx) =>
      tx.prisma.auditLog.findMany({ select: { seq: true } }),
    );
    expect(seqs.map((s) => s.seq).sort()).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);
  });

  it('writes the setup audit trail with before and after', async () => {
    await asApp(
      A,
      (tx) =>
        audit.setup(tx, {
          action: 'profile.updated',
          entityType: 'profile',
          entityId: USER,
          entityName: 'Sales Rep',
          before: { name: 'Rep' },
          after: { name: 'Sales Rep' },
        }),
      USER,
    );
    await asApp(A, (tx) => audit.setup(tx, { action: 'org_unit.created', entityType: 'org_unit' }));
    const rows = await asApp(A, (tx) =>
      tx.prisma.setupAudit.findMany({ orderBy: { occurredAt: 'asc' } }),
    );
    expect(rows[0]).toMatchObject({
      actorId: USER,
      before: { name: 'Rep' },
      after: { name: 'Sales Rep' },
    });
    expect(rows[1]).toMatchObject({ actorId: null, before: null, after: null });
  });
});

describe('append-only (ADR-0008)', () => {
  it('refuses updates and deletes from the runtime role, and any change but the hash from sm_audit', async () => {
    await expect(
      asApp(A, (tx) => tx.prisma.auditLog.updateMany({ data: { action: 'forged' } })),
    ).rejects.toThrow(/permission denied/);
    await expect(asApp(A, (tx) => tx.prisma.auditLog.deleteMany())).rejects.toThrow(
      /permission denied/,
    );
    await expect(asApp(A, (tx) => tx.prisma.setupAudit.deleteMany())).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      withTenant(auditor, { tenantId: A }, (tx) =>
        tx.prisma.auditLog.updateMany({ data: { action: 'forged' } }),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(
        auditor,
        { tenantId: A },
        (tx) =>
          tx.prisma
            .$executeRaw`UPDATE audit_log SET hash = 'x', prev_hash = NULL WHERE seq = 1 AND tenant_id = app_current_tenant_id() AND hash IS NOT NULL`,
      ),
    ).resolves.toBe(0);
  });

  it('refuses even the owner', async () => {
    await admin.query('SET ROLE sm_migrator');
    try {
      await admin.query('BEGIN');
      await admin.query(`SELECT set_config('app.tenant_id', $1, true)`, [A]);
      await expect(admin.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
    } finally {
      await admin.query('ROLLBACK');
      await admin.query('RESET ROLE');
    }
  });
});

describe('audit.chain and audit.verify (ADR-0008 addendum)', () => {
  it('chains committed rows in sequence order, in batches linked by their roots', async () => {
    const result = await chain(A, { batchSize: 2 });
    expect(result).toMatchObject({ rows: 3, batches: 2, gaps: [], headSeq: 3n });
    const rows = await asApp(A, (tx) => tx.prisma.auditLog.findMany({ orderBy: { seq: 'asc' } }));
    expect(rows[0]?.prevHash).toBe(GENESIS);
    expect(rows[1]?.prevHash).toBe(rows[0]?.hash);
    const batches = await asApp(A, (tx) =>
      tx.prisma.auditBatch.findMany({ orderBy: { lastSeq: 'asc' } }),
    );
    expect(batches.map((b) => [b.firstSeq, b.lastSeq])).toEqual([
      [1n, 2n],
      [3n, 3n],
    ]);
    expect(batches[1]?.prevRoot).toBe(batches[0]?.merkleRoot);
    expect(await verify(A)).toEqual({
      ok: true,
      throughSeq: 3n,
      batches: 2,
      rows: 3,
      pending: 0,
      problem: null,
    });
    expect(await chain(A)).toMatchObject({ rows: 0, batches: 0 });
  });

  it('waits at a missing number until it must have rolled back, then declares the gap', async () => {
    await expect(
      asApp(A, async (tx) => {
        await audit.record(tx, { action: 'will.roll_back' }); // takes seq 4
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    await asApp(A, (tx) => audit.record(tx, { action: 'after.gap' })); // seq 5
    expect(await chain(A)).toMatchObject({ rows: 0 }); // seq 4 might still commit
    const pending = await verify(A);
    expect(pending).toMatchObject({ ok: true, pending: 1 });
    expect(await chain(A, { now: later })).toMatchObject({ rows: 1, gaps: [4n], headSeq: 5n });
    expect(await verify(A)).toMatchObject({ ok: true, throughSeq: 5n, rows: 4 });
  });

  it('reports rows left unchained for too long', async () => {
    await asApp(A, (tx) => audit.record(tx, { action: 'not.chained.yet' }));
    const stale = await verify(A, { now: later });
    expect(stale.ok).toBe(false);
    expect(stale.problem).toMatch(/waited too long/);
    await chain(A);
  });

  it('detects a forged row, a deleted row and a row revived in a gap', async () => {
    const tamper = async (sql: string) => {
      await admin.query('BEGIN');
      await admin.query('SET LOCAL session_replication_role = replica'); // bypasses the guard trigger
      await admin.query(sql, [A]);
      await admin.query('COMMIT');
    };
    await tamper(`UPDATE audit_log SET payload = '{"i": 99}' WHERE tenant_id = $1 AND seq = 2`);
    expect(await verify(A)).toMatchObject({ ok: false, problem: 'row 2 does not match its hash' });
    await tamper(`UPDATE audit_log SET payload = '{"i": 1}' WHERE tenant_id = $1 AND seq = 2`);
    expect(await verify(A)).toMatchObject({ ok: true });

    const [row] = (
      await admin.query(`SELECT * FROM audit_log WHERE tenant_id = $1 AND seq = 5`, [A])
    ).rows as Record<string, unknown>[];
    await tamper(`DELETE FROM audit_log WHERE tenant_id = $1 AND seq = 5`);
    const missing = await verify(A);
    expect(missing.ok).toBe(false);
    expect(missing.problem).toMatch(/missing rows/);
    await admin.query('BEGIN');
    await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query(
      `INSERT INTO audit_log SELECT * FROM jsonb_populate_record(NULL::audit_log, $1::jsonb)`,
      [JSON.stringify(row)],
    );
    await admin.query('COMMIT');
    expect(await verify(A)).toMatchObject({ ok: true });

    await tamper(
      `INSERT INTO audit_log (tenant_id, id, occurred_at, seq, actor_type, action)
       VALUES ($1, uuid_generate_v7(), now(), 4, 'system', 'revived')`,
    );
    expect(await verify(A)).toMatchObject({
      ok: false,
      problem: 'row 4 exists although it was declared a gap',
    });
  });

  it('keeps every tenant’s chain to itself', async () => {
    expect(await chain(B)).toMatchObject({ rows: 1, batches: 1 });
    expect(await verify(B)).toMatchObject({ ok: true, rows: 1 });
    const seen = await withTenant(auditor, { tenantId: B }, (tx) => tx.prisma.auditLog.count());
    expect(seen).toBe(1);
  });
});

describe('audit partitions', () => {
  it('keeps monthly partitions ahead, each with forced RLS and the guard', async () => {
    expect(await audit.maintainPartitions(app)).toEqual([]);
    const { rows } = await admin.query<{ relname: string; forced: boolean }>(`
      SELECT c.relname, c.relforcerowsecurity AS forced FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'audit_log'::regclass`);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) expect(r.forced, r.relname).toBe(true);
    const { rows: grants } = await admin.query<{ privilege_type: string }>(
      `
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'sm_app' AND table_name = $1`,
      [rows[0]?.relname],
    );
    expect(grants.map((g) => g.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
  });
});
