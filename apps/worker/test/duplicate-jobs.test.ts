import { DUPLICATE_SCAN_TOPIC, DUPLICATE_SCHEDULE_TOPIC } from '@sm/records';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMaintenanceHandler } from '../src/maintenance.js';
import { startTestWorker, type TestWorker } from './support.js';

let w: TestWorker;
let tenant = '';

const envelope = (topic: string, tenantId: string | null, payload: unknown = {}) => ({
  eventId: `${topic}-${String(Math.random())}`,
  tenantId,
  topic,
  aggregateType: null,
  aggregateId: null,
  payload,
  createdAt: new Date().toISOString(),
});

beforeAll(async () => {
  w = await startTestWorker();
  tenant = await w.tenant('dedupe-jobs');
  await w.inTenant(tenant, (tx) =>
    tx.prisma.tenantSettings.create({
      data: {
        tenantId: tenant,
        name: 'dedupe',
        slug: 'dedupe-jobs',
        region: 'eu-central-1',
        corporateCurrency: 'USD',
        defaultTimezone: 'UTC',
      },
    }),
  );
});

afterAll(async () => {
  await w.dispose();
});

describe('duplicate jobs on the maintenance queue (§7.2)', () => {
  it('runs a queued job, and due scheduled jobs for every tenant', async () => {
    const handler = createMaintenanceHandler({ controlPlane: w.controlPlane });
    const ctx = { prisma: w.prisma, logger: w.logger, job: undefined as never };
    const jobId = await w.inTenant(tenant, async (tx) => {
      const rule = await tx.prisma.matchingRule.create({
        data: {
          tenantId: tenant,
          object: 'lead',
          name: 'Email',
          conditions: [{ field: 'email', method: 'email' }] as never,
        },
      });
      const job = await tx.prisma.duplicateJob.create({
        data: { tenantId: tenant, object: 'lead', matchingRuleId: rule.id, schedule: 'weekly' },
      });
      return job.id;
    });
    await handler(envelope(DUPLICATE_SCAN_TOPIC, tenant, { jobId }), ctx);
    // No lead metadata in this bare tenant: the job ends (failed) instead of hanging.
    const run = await w.inTenant(tenant, (tx) =>
      tx.prisma.duplicateJob.findFirstOrThrow({ where: { id: jobId } }),
    );
    expect(run.status).toBe('FAILED');
    expect(run.nextRunAt).not.toBeNull();
    // Due now: the hourly sweep runs it again.
    await w.inTenant(tenant, (tx) =>
      tx.prisma.duplicateJob.update({
        where: { tenantId_id: { tenantId: tenant, id: jobId } },
        data: { nextRunAt: new Date(Date.now() - 1000) },
      }),
    );
    await handler(envelope(DUPLICATE_SCHEDULE_TOPIC, null), ctx);
    const again = await w.inTenant(tenant, (tx) =>
      tx.prisma.duplicateJob.findFirstOrThrow({ where: { id: jobId } }),
    );
    expect(again.startedAt?.getTime()).toBeGreaterThan(run.startedAt?.getTime() ?? 0);
    await expect(handler(envelope(DUPLICATE_SCAN_TOPIC, null, { jobId }), ctx)).rejects.toThrow(
      /needs a tenant/,
    );
  });

  it('sweeps hourly', async () => {
    await w.start();
    const schedulers = await w.queues.get('maintenance').getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toContain(DUPLICATE_SCHEDULE_TOPIC);
  });
});
