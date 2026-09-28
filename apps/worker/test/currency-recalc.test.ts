import { CURRENCY_RECALC_TOPIC } from '@sm/records';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMaintenanceHandler } from '../src/maintenance.js';
import { startTestWorker, type TestWorker } from './support.js';

let w: TestWorker;
let tenant = '';

const envelope = (tenantId: string | null, payload: Record<string, unknown>) => ({
  eventId: CURRENCY_RECALC_TOPIC,
  tenantId,
  topic: CURRENCY_RECALC_TOPIC,
  aggregateType: null,
  aggregateId: null,
  payload,
  createdAt: new Date().toISOString(),
});

beforeAll(async () => {
  w = await startTestWorker();
  tenant = await w.tenant('currency-recalc');
  await w.inTenant(tenant, (tx) =>
    tx.prisma.tenantSettings.create({
      data: {
        tenantId: tenant,
        name: 'fx',
        slug: 'currency-recalc',
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

describe('currency recalculation in the worker', () => {
  const ctx = () => ({ prisma: w.prisma, logger: w.logger, job: undefined as never });

  it('runs the tenant’s recalculation job to completion', async () => {
    const run = await w.inTenant(tenant, (tx) =>
      tx.prisma.jobRun.create({ data: { tenantId: tenant, kind: 'currency_recalc' } }),
    );
    await createMaintenanceHandler()(
      envelope(tenant, { jobRunId: run.id, code: 'EUR', date: '2026-01-01' }),
      ctx(),
    );
    expect(
      await w.inTenant(tenant, (tx) =>
        tx.prisma.jobRun.findFirstOrThrow({ where: { id: run.id } }),
      ),
    ).toMatchObject({ status: 'SUCCEEDED', done: 0 });
  });

  it('needs a tenant and a well-formed payload', async () => {
    await expect(createMaintenanceHandler()(envelope(null, {}), ctx())).rejects.toThrow(
      /needs a tenant/,
    );
    await expect(
      createMaintenanceHandler()(envelope(tenant, { code: 'EUR' }), ctx()),
    ).rejects.toThrow();
  });
});
