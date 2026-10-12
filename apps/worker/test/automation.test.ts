import { readdirSync, readFileSync } from 'node:fs';

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

  it('knows every automation topic RecordService emits', () => {
    const dir = new URL('../../../packages/records/src/', import.meta.url);
    const emitted = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts')))
      for (const m of readFileSync(new URL(file, dir), 'utf8').matchAll(/'(automation\.[a-z_]+)'/g))
        if (m[1]) emitted.add(m[1]);
    expect(emitted.size).toBeGreaterThan(5);
    expect([...emitted].filter((t) => !RECORD_EVENTS.has(t))).toEqual([]);
  });

  it('refuses topics it does not know', async () => {
    await expect(automationHandler(envelope('automation.nope'), ctx)).rejects.toThrow(
      /unknown automation job/,
    );
  });
});
