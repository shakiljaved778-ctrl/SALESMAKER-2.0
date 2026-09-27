import { describe, expect, it } from 'vitest';

import { automationHandler, RECORD_EVENTS } from '../src/automation.js';

const envelope = (topic: string) => ({
  eventId: 'e',
  tenantId: '01920000-0000-7000-8000-000000000001',
  topic,
  aggregateType: 'lead',
  aggregateId: null,
  payload: {},
  createdAt: new Date().toISOString(),
});
const ctx = { job: undefined as never, prisma: undefined as never, logger: undefined as never };

describe('automation queue', () => {
  it('acknowledges record events until flows arrive (P08)', async () => {
    for (const topic of RECORD_EVENTS)
      await expect(automationHandler(envelope(topic), ctx)).resolves.toBeUndefined();
  });

  it('refuses topics it does not know', async () => {
    await expect(automationHandler(envelope('automation.nope'), ctx)).rejects.toThrow(
      /unknown automation job/,
    );
  });
});
