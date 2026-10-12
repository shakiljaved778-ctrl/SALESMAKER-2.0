import {
  IMPORT_DRY_RUN_TOPIC,
  IMPORT_RUN_TOPIC,
  IMPORT_UNDO_TOPIC,
  INBOUND_EMAIL_TOPIC,
} from '@sm/imports';
import { FakeStorageProvider } from '@sm/integrations';
import { MASS_ACTION_TOPIC } from '@sm/records';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEmailSyncHandler } from '../src/inbound-email.js';
import { createImportHandler, importHandler } from '../src/mass-actions.js';
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

  it('runs import jobs with object storage (a job that no longer exists is done)', async () => {
    const handler = createImportHandler({ storage: new FakeStorageProvider() });
    const jobId = '01920000-0000-7000-8000-00000000f003';
    for (const topic of [IMPORT_RUN_TOPIC, IMPORT_DRY_RUN_TOPIC, IMPORT_UNDO_TOPIC])
      await expect(handler(envelope(topic, tenant, { jobId }), ctx())).resolves.toBeUndefined();
    await expect(handler(envelope(IMPORT_RUN_TOPIC, tenant, {}), ctx())).rejects.toThrow(
      /needs a jobId/,
    );
    await expect(
      importHandler(envelope(IMPORT_RUN_TOPIC, tenant, { jobId }), ctx()),
    ).rejects.toThrow(/not configured/);
  });
});

describe('the email-sync queue', () => {
  const ctx = () => ({ prisma: w.prisma, logger: w.logger, job: undefined as never });
  const emailId = '01920000-0000-7000-8000-00000000f004';

  it('processes inbound emails (one that no longer exists is done)', async () => {
    const handler = createEmailSyncHandler({ storage: new FakeStorageProvider() });
    await expect(
      handler(envelope(INBOUND_EMAIL_TOPIC, tenant, { emailId }), ctx()),
    ).resolves.toBeUndefined();
  });

  it('rejects malformed jobs and runs only with storage', async () => {
    const handler = createEmailSyncHandler({ storage: new FakeStorageProvider() });
    await expect(handler(envelope('email-sync.other', tenant, {}), ctx())).rejects.toThrow(
      /unknown email-sync job/,
    );
    await expect(handler(envelope(INBOUND_EMAIL_TOPIC, null, { emailId }), ctx())).rejects.toThrow(
      /needs a tenant/,
    );
    await expect(handler(envelope(INBOUND_EMAIL_TOPIC, tenant, {}), ctx())).rejects.toThrow(
      /needs an emailId/,
    );
    await expect(
      createEmailSyncHandler()(envelope(INBOUND_EMAIL_TOPIC, tenant, { emailId }), ctx()),
    ).rejects.toThrow(/not configured/);
  });
});
