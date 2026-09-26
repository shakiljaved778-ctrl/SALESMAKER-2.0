import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createCellPrisma, disposeCellPrisma, type CellPrisma } from '../src/client.js';
import { outbox, queueOf } from '../src/outbox.js';
import { withTenant, type TenantTransaction } from '../src/tenant.js';
import { createTestCellDatabase, type TestCellDatabase } from '../src/testing/cell-database.js';

const TENANT = '01920000-0000-7000-8000-0000000000e1';
const OTHER = '01920000-0000-7000-8000-0000000000e2';

let db: TestCellDatabase;
let prisma: CellPrisma;
let admin: pg.Client;

const inTenant = <T>(tenantId: string, fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(prisma, { tenantId }, fn);

beforeAll(async () => {
  db = await createTestCellDatabase(inject('pgServerAdminUrl'));
  prisma = createCellPrisma(db.appUrl);
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await disposeCellPrisma(prisma);
  await db.drop();
});

describe('queueOf', () => {
  it('routes a topic to the queue its prefix names', () => {
    expect(queueOf('sharing.owner_changed')).toBe('sharing');
    expect(queueOf('webhooks-out.record.created')).toBe('webhooks-out');
    for (const bad of ['sharing', 'nope.thing', 'Sharing.x', '.x', 'sharing.'])
      expect(() => queueOf(bad), bad).toThrow(/known queue/);
  });
});

describe('outbox (§3.7, §3.9)', () => {
  it('emits events in the caller’s transaction and rolls them back with it', async () => {
    const ids = await inTenant(TENANT, (tx) =>
      outbox.emit(tx, [
        { topic: 'sharing.owner_changed', payload: { recordId: 'r1' }, aggregateType: 'lead' },
        { topic: 'index.record_changed' },
      ]),
    );
    expect(ids).toHaveLength(2);
    await expect(
      inTenant(TENANT, async (tx) => {
        await outbox.emit(tx, { topic: 'sharing.owner_changed' });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await inTenant(TENANT, (tx) => tx.prisma.outboxEvent.count())).toBe(2);
    expect(await inTenant(TENANT, (tx) => outbox.emit(tx, []))).toEqual([]);
  });

  it('refuses a topic that names no queue, in code and in the database', async () => {
    await expect(
      inTenant(TENANT, (tx) => outbox.emit(tx, { topic: 'bogus.event' })),
    ).rejects.toThrow(/known queue/);
    await expect(
      inTenant(TENANT, (tx) =>
        tx.prisma.outboxEvent.create({ data: { tenantId: TENANT, topic: 'NoDot' } }),
      ),
    ).rejects.toThrow(/outbox_event_topic/);
  });

  it('claims oldest first, skips rows another relay holds, and marks them published', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstClaim: string[] = [];
    const holder = inTenant(TENANT, async (tx) => {
      firstClaim = (await outbox.claim(tx, 1)).map((e) => e.topic);
      await held; // keep the lock while the second relay claims
    });
    await new Promise((r) => setTimeout(r, 200));
    const second = await inTenant(TENANT, async (tx) => {
      const events = await outbox.claim(tx, 10);
      await outbox.markPublished(
        tx,
        events.map((e) => e.id),
      );
      return events;
    });
    release();
    await holder;
    expect(firstClaim).toEqual(['sharing.owner_changed']);
    expect(second.map((e) => e.topic)).toEqual(['index.record_changed']);
    expect(second[0]).toMatchObject({ tenantId: TENANT, aggregateType: null, payload: {} });

    const remaining = await inTenant(TENANT, async (tx) => {
      const events = await outbox.claim(tx);
      await outbox.markPublished(
        tx,
        events.map((e) => e.id),
      );
      await outbox.markPublished(tx, []);
      return events;
    });
    expect(remaining.map((e) => e.payload)).toEqual([{ recordId: 'r1' }]);
    expect(await inTenant(TENANT, (tx) => outbox.claim(tx))).toEqual([]);
  });

  it('never shows one tenant another tenant’s events', async () => {
    await inTenant(OTHER, (tx) => outbox.emit(tx, { topic: 'index.record_changed' }));
    const seen = await inTenant(TENANT, (tx) =>
      tx.prisma.outboxEvent.findMany({ select: { tenantId: true } }),
    );
    expect(new Set(seen.map((e) => e.tenantId))).toEqual(new Set([TENANT]));
    expect(await inTenant(OTHER, (tx) => outbox.claim(tx))).toHaveLength(1);
  });

  it('wakes a listener on commit with only the tenant id', async () => {
    const listener = new pg.Client({ connectionString: db.appUrl });
    await listener.connect();
    const payloads: string[] = [];
    listener.on('notification', (n) => payloads.push(n.payload ?? ''));
    await listener.query('LISTEN sm_outbox');
    await inTenant(OTHER, (tx) => outbox.emit(tx, [{ topic: 'index.a' }, { topic: 'index.b' }]));
    await new Promise((r) => setTimeout(r, 300));
    await listener.end();
    expect(payloads).toEqual([OTHER]); // one wake-up per transaction and tenant
  });
});

describe('outbox partitions', () => {
  it('keeps daily partitions ahead, each with forced RLS', async () => {
    await outbox.maintainPartitions(prisma, { daysAhead: 10 });
    const { rows } = await admin.query<{ relname: string; forced: boolean; policies: number }>(`
      SELECT c.relname, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname
                AND p.policyname = 'tenant_isolation') AS policies
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'outbox_event'::regclass ORDER BY 1`);
    expect(rows.length).toBeGreaterThanOrEqual(12); // yesterday .. today + 10
    for (const r of rows) expect(r, r.relname).toMatchObject({ forced: true, policies: 1 });
    const again = await outbox.maintainPartitions(prisma, { daysAhead: 10 });
    expect(again).toEqual({ created: [], dropped: [] });
  });

  it('drops partitions past retention', async () => {
    await admin.query(`SET ROLE sm_migrator`);
    await admin.query(
      `CREATE TABLE outbox_event_p20200101 PARTITION OF outbox_event
       FOR VALUES FROM ('2020-01-01 00:00+00') TO ('2020-01-02 00:00+00')`,
    );
    await admin.query(`RESET ROLE`);
    const { dropped } = await outbox.maintainPartitions(prisma);
    expect(dropped).toEqual(['outbox_event_p20200101']);
  });

  it('rejects out-of-range settings, and keeps DDL away from the runtime role', async () => {
    await expect(outbox.maintainPartitions(prisma, { daysAhead: 0 })).rejects.toThrow(/days ahead/);
    await expect(
      prisma.$executeRawUnsafe(
        `CREATE TABLE outbox_event_p20300101 PARTITION OF outbox_event
         FOR VALUES FROM ('2030-01-01') TO ('2030-01-02')`,
      ),
    ).rejects.toThrow(/permission denied|must be owner/);
  });
});
