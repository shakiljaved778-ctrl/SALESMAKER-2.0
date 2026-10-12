import { SLA_TICK_TOPIC } from '@sm/records';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMaintenanceHandler } from '../src/maintenance.js';
import { startTestWorker, type TestWorker } from './support.js';

let w: TestWorker;
let tenant = '';

beforeAll(async () => {
  w = await startTestWorker();
  tenant = await w.tenant('sla-tick');
  await w.inTenant(tenant, (tx) =>
    tx.prisma.tenantSettings.create({
      data: {
        tenantId: tenant,
        name: 'sla',
        slug: 'sla-tick',
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

describe('SLA tick on the maintenance queue (§7.3)', () => {
  it('breaches due timers for every tenant and tells the owner, once', async () => {
    const { timerId, userId } = await w.inTenant(tenant, async (tx) => {
      const user = await tx.prisma.user.create({
        data: { tenantId: tenant, email: 'owner@sla.test', name: 'Owner', status: 'ACTIVE' },
      });
      const policy = await tx.prisma.slaPolicy.create({
        data: {
          tenantId: tenant,
          name: 'Touch',
          metric: 'FIRST_TOUCH',
          targetMinutes: 10,
          warnAtPercent: null,
          managerAtPercent: null,
        },
      });
      const started = new Date(Date.now() - 20 * 60_000);
      const timer = await tx.prisma.slaTimer.create({
        data: {
          tenantId: tenant,
          policyId: policy.id,
          object: 'lead',
          recordId: '01920000-0000-7000-8000-0000000051a0',
          ownerId: user.id,
          startedAt: started,
          dueAt: new Date(started.getTime() + 10 * 60_000),
          nextActionAt: new Date(started.getTime() + 10 * 60_000),
        },
      });
      return { timerId: timer.id, userId: user.id };
    });
    const handler = createMaintenanceHandler({ controlPlane: w.controlPlane });
    const envelope = {
      eventId: SLA_TICK_TOPIC,
      tenantId: null,
      topic: SLA_TICK_TOPIC,
      aggregateType: null,
      aggregateId: null,
      payload: {},
      createdAt: new Date().toISOString(),
    };
    const ctx = { prisma: w.prisma, logger: w.logger, job: undefined as never };
    await handler(envelope, ctx);
    await handler(envelope, ctx);
    const timer = await w.inTenant(tenant, (tx) =>
      tx.prisma.slaTimer.findFirstOrThrow({ where: { id: timerId } }),
    );
    expect(timer).toMatchObject({ status: 'BREACHED', nextActionAt: null, stepsDone: ['breach'] });
    const notes = await w.inTenant(tenant, (tx) =>
      tx.prisma.notification.findMany({ where: { userId } }),
    );
    expect(notes.map((n) => n.kind)).toEqual(['sla_breach']);
  });

  it('ticks every minute', async () => {
    await w.start();
    const schedulers = await w.queues.get('maintenance').getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toContain(SLA_TICK_TOPIC);
  });
});
