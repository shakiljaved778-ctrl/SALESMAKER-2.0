import { audit } from '@sm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AUDIT_CHAIN_TOPIC,
  AUDIT_VERIFY_TOPIC,
  createMaintenanceHandler,
  maintenanceHandler,
} from '../src/maintenance.js';
import { eventually, startTestWorker, type TestWorker } from './support.js';

let w: TestWorker;
let alpha = '';
let beta = '';

const envelope = (topic: string, tenantId: string | null) => ({
  eventId: topic,
  tenantId,
  topic,
  aggregateType: null,
  aggregateId: null,
  payload: {},
  createdAt: new Date().toISOString(),
});

beforeAll(async () => {
  // The default handlers: maintenance with the sm_audit connection, Valkey and the control plane.
  w = await startTestWorker();
  alpha = await w.tenant('audit-alpha');
  beta = await w.tenant('audit-beta');
  await w.start();
});

afterAll(async () => {
  await w.dispose();
});

describe('audit chaining in the worker (ADR-0008 addendum)', () => {
  it('chains a tenant’s rows soon after they commit', async () => {
    await w.inTenant(alpha, async (tx) => {
      await audit.record(tx, { action: 'record.created', object: 'lead' });
      await audit.record(tx, { action: 'record.updated', object: 'lead' });
    });
    await eventually(async () =>
      w.inTenant(
        alpha,
        async (tx) => (await tx.prisma.auditLog.count({ where: { hash: null } })) === 0,
      ),
    );
    expect(await w.inTenant(alpha, (tx) => tx.prisma.auditBatch.count())).toBeGreaterThanOrEqual(1);
  });

  it('leaves a run to the lock holder, which picks the request up when it finishes', async () => {
    const handler = createMaintenanceHandler({ auditPrisma: w.auditPrisma, redis: w.redis });
    const ctx = { prisma: w.prisma, logger: w.logger, job: undefined as never };
    // Someone else holds the lock: this run only marks the tenant dirty.
    await w.redis.set(`audit-chain:${beta}`, 'someone-else', 'PX', 60_000);
    await w.inTenant(beta, (tx) => audit.record(tx, { action: 'x.y' }));
    await handler(envelope(AUDIT_CHAIN_TOPIC, beta), ctx);
    expect(await w.redis.get(`audit-chain-dirty:${beta}`)).toBe('1');
    // The holder's next run clears the mark and chains everything waiting.
    await w.redis.del(`audit-chain:${beta}`);
    await handler(envelope(AUDIT_CHAIN_TOPIC, beta), ctx);
    expect(
      await w.inTenant(beta, (tx) => tx.prisma.auditLog.count({ where: { hash: null } })),
    ).toBe(0);
    expect(await w.redis.get(`audit-chain-dirty:${beta}`)).toBeNull();
  });

  it('verifies every tenant daily and records the result', async () => {
    // Let the chain jobs that the earlier writes queued finish first.
    for (const tenantId of [alpha, beta])
      await eventually(async () =>
        w.inTenant(
          tenantId,
          async (tx) => (await tx.prisma.auditLog.count({ where: { hash: null } })) === 0,
        ),
      );
    const handler = createMaintenanceHandler({
      auditPrisma: w.auditPrisma,
      redis: w.redis,
      controlPlane: {
        listCellTenants: (options = {}) => w.controlPlane.listCellTenants({ ...options, limit: 1 }),
      },
    });
    await handler(envelope(AUDIT_VERIFY_TOPIC, null), {
      prisma: w.prisma,
      logger: w.logger,
      job: undefined as never,
    });
    for (const tenantId of [alpha, beta]) {
      const [run] = await w.inTenant(tenantId, (tx) => tx.prisma.auditVerification.findMany());
      expect(run).toMatchObject({ status: 'OK', pending: 0, problem: null });
    }
    const betaRun = await w.inTenant(beta, (tx) => tx.prisma.auditVerification.findFirstOrThrow());
    expect(betaRun.rows).toBe(1);
  });

  it('records a broken chain', async () => {
    const handler = createMaintenanceHandler({
      auditPrisma: w.auditPrisma,
      redis: w.redis,
      controlPlane: { listCellTenants: () => Promise.resolve({ tenantIds: [alpha], next: null }) },
    });
    const pg = await import('pg');
    const admin = new pg.default.Client({ connectionString: w.db.adminUrl });
    await admin.connect();
    await admin.query('BEGIN');
    await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query(`UPDATE audit_log SET action = 'forged' WHERE tenant_id = $1 AND seq = 1`, [
      alpha,
    ]);
    await admin.query('COMMIT');
    await admin.end();
    await handler(envelope(AUDIT_VERIFY_TOPIC, null), {
      prisma: w.prisma,
      logger: w.logger,
      job: undefined as never,
    });
    const latest = await w.inTenant(alpha, (tx) =>
      tx.prisma.auditVerification.findFirstOrThrow({ orderBy: { startedAt: 'desc' } }),
    );
    expect(latest).toMatchObject({ status: 'BROKEN', problem: 'row 1 does not match its hash' });
  });

  it('refuses audit jobs without their dependencies or tenant', async () => {
    const ctx = { prisma: w.prisma, logger: w.logger, job: undefined as never };
    await expect(maintenanceHandler(envelope(AUDIT_CHAIN_TOPIC, alpha), ctx)).rejects.toThrow(
      /needs Valkey/,
    );
    await expect(maintenanceHandler(envelope(AUDIT_CHAIN_TOPIC, null), ctx)).rejects.toThrow(
      /needs a tenant/,
    );
    await expect(maintenanceHandler(envelope(AUDIT_VERIFY_TOPIC, null), ctx)).rejects.toThrow(
      /control plane/,
    );
  });

  it('schedules the daily verification', async () => {
    const schedulers = await w.queues.get('maintenance').getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toContain(AUDIT_VERIFY_TOPIC);
  });
});
