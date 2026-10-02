import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMaintenanceHandler, RECYCLE_PURGE_TOPIC } from '../src/maintenance.js';
import { startTestWorker, type TestWorker } from './support.js';

let w: TestWorker;
let alpha = '';
let bare = '';

const envelope = (tenantId: string | null) => ({
  eventId: RECYCLE_PURGE_TOPIC,
  tenantId,
  topic: RECYCLE_PURGE_TOPIC,
  aggregateType: null,
  aggregateId: null,
  payload: {},
  createdAt: new Date().toISOString(),
});

const item = (tenantId: string, recordId: string, purgeAfter: Date) =>
  w.inTenant(tenantId, (tx) =>
    tx.prisma.recycleBinItem.create({
      data: {
        tenantId,
        object: 'lead',
        recordId,
        name: 'Chen',
        deletedAt: new Date(purgeAfter.getTime() - 30 * 86_400_000),
        purgeAfter,
      },
    }),
  );

beforeAll(async () => {
  w = await startTestWorker();
  alpha = await w.tenant('purge-alpha');
  // A tenant reserved in the control plane but never provisioned in the cell.
  bare = await w.tenant('purge-bare');
  await w.inTenant(alpha, (tx) =>
    tx.prisma.tenantSettings.create({
      data: {
        tenantId: alpha,
        name: 'alpha',
        slug: 'purge-alpha',
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

describe('recycle-bin purge (§7.5)', () => {
  it('purges every tenant’s expired items and keeps the rest', async () => {
    const day = 86_400_000;
    await item(alpha, '01920000-0000-7000-8000-00000000a001', new Date(Date.now() - day));
    await item(alpha, '01920000-0000-7000-8000-00000000a002', new Date(Date.now() + day));
    const handler = createMaintenanceHandler({ controlPlane: w.controlPlane });
    await w.inTenant(alpha, (tx) =>
      tx.prisma.idempotencyKey.createMany({
        data: ['old', 'fresh'].map((key) => ({
          tenantId: alpha,
          key,
          requestHash: Buffer.from('h'),
          responseStatus: 201,
          responseBody: {},
          expiresAt: new Date(Date.now() + (key === 'old' ? -day : day)),
        })),
      }),
    );
    await handler(envelope(null), { prisma: w.prisma, logger: w.logger, job: undefined as never });
    expect(
      (await w.inTenant(alpha, (tx) => tx.prisma.idempotencyKey.findMany())).map((k) => k.key),
    ).toEqual(['fresh']);
    const left = await w.inTenant(alpha, (tx) => tx.prisma.recycleBinItem.findMany());
    expect(left.map((i) => i.recordId)).toEqual(['01920000-0000-7000-8000-00000000a002']);
    // One tenant on demand; an unprovisioned tenant is a no-op.
    await handler(envelope(bare), { prisma: w.prisma, logger: w.logger, job: undefined as never });
  });

  it('is scheduled daily', async () => {
    await w.start();
    const schedulers = await w.queues.get('maintenance').getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toContain(RECYCLE_PURGE_TOPIC);
  });
});
