import { MASS_ACTION_TOPIC } from '@sm/records';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { importHandler } from '../src/mass-actions.js';
import { startTestWorker, type TestWorker } from './support.js';

let w: TestWorker;
let tenant = '';

const envelope = (topic: string, tenantId: string | null, payload: Record<string, unknown>) => ({
  eventId: topic,
  tenantId,
  topic,
  aggregateType: null,
  aggregateId: null,
  payload,
  createdAt: new Date().toISOString(),
});

beforeAll(async () => {
  w = await startTestWorker();
  tenant = await w.tenant('mass-actions');
});

afterAll(async () => {
  await w.dispose();
});

describe('the import queue', () => {
  const ctx = () => ({ prisma: w.prisma, logger: w.logger, job: undefined as never });
  const payload = {
    jobRunId: '01920000-0000-7000-8000-00000000f001',
    userId: '01920000-0000-7000-8000-00000000f002',
    spec: { object: 'lead', action: { kind: 'delete' } },
  };

  it('runs mass actions in the tenant (a job run that no longer exists is done)', async () => {
    await expect(
      importHandler(envelope(MASS_ACTION_TOPIC, tenant, payload), ctx()),
    ).resolves.toBeUndefined();
  });

  it('rejects malformed jobs', async () => {
    await expect(importHandler(envelope('import.other', tenant, {}), ctx())).rejects.toThrow(
      /unknown import job/,
    );
    await expect(importHandler(envelope(MASS_ACTION_TOPIC, null, payload), ctx())).rejects.toThrow(
      /needs a tenant/,
    );
    await expect(
      importHandler(envelope(MASS_ACTION_TOPIC, tenant, { jobRunId: 'x' }), ctx()),
    ).rejects.toThrow();
  });
});
