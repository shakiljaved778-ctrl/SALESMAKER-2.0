import { outbox } from '@sm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_PRIORITY } from '../src/fairness.js';
import type { JobEnvelope } from '../src/jobs.js';
import { maintenanceHandler, OUTBOX_PARTITIONS_TOPIC } from '../src/maintenance.js';
import { eventually, startTestWorker, type TestWorker } from './support.js';

const processed: JobEnvelope[] = [];
let w: TestWorker;
let big = '';
let small = '';

beforeAll(async () => {
  w = await startTestWorker({
    config: { WORKER_CONCURRENCY: 1, JOB_ATTEMPTS: 2 },
    handlers: {
      index: async (envelope) => {
        processed.push(envelope);
        await new Promise((r) => setTimeout(r, 5));
      },
      automation: () => Promise.reject(new Error('automation exploded')),
      maintenance: maintenanceHandler,
    },
  });
  big = await w.tenant('bigco');
  small = await w.tenant('smallco');
});

afterAll(async () => {
  await w.dispose();
});

describe('FairScheduler', () => {
  it('counts a tenant’s jobs in flight per queue, never below zero, capped at the BullMQ maximum', async () => {
    const f = w.fairness;
    expect(await f.admit('reports', 't1')).toBe(1);
    expect(await f.admit('reports', 't1')).toBe(2);
    expect(await f.admit('reports', 't2')).toBe(1);
    await f.release('reports', 't1');
    expect(await f.inFlight('reports', 't1')).toBe(1);
    await f.release('reports', 't1');
    await f.release('reports', 't1');
    expect(await f.inFlight('reports', 't1')).toBe(0);
    await w.redis.set(`${w.config.QUEUE_PREFIX}:fair:reports:t3`, String(MAX_PRIORITY + 10));
    expect(await f.admit('reports', 't3')).toBe(MAX_PRIORITY);
  });
});

describe('consumers', () => {
  it('interleave tenants: one tenant’s backlog does not starve another', async () => {
    // Both backlogs are queued before any consumer runs, so only priority decides the order.
    await w.inTenant(big, (tx) =>
      outbox.emit(
        tx,
        Array.from({ length: 30 }, (_, i) => ({ topic: 'index.record_changed', payload: { i } })),
      ),
    );
    await w.relay.drain(big);
    await w.inTenant(small, (tx) => outbox.emit(tx, { topic: 'index.record_changed' }));
    await w.relay.drain(small);
    await w.start();
    await eventually(() => Promise.resolve(processed.length === 31));
    const position = processed.findIndex((e) => e.tenantId === small);
    // The small tenant's only job ran at priority 1: ahead of all but the big tenant’s first job.
    expect(position).toBeLessThan(2);
    await eventually(async () => (await w.fairness.inFlight('index', big)) === 0);
    expect(await w.fairness.inFlight('index', small)).toBe(0);
  });

  it('retry a failing job, then copy it to the dead-letter queue and free its slot', async () => {
    const [id] = await w.inTenant(small, (tx) =>
      outbox.emit(tx, { topic: 'automation.after_save', payload: { recordId: 'r9' } }),
    );
    await w.relay.drain(small);
    const dead = await eventually(async () => w.queues.deadLetter.getJob(`automation.${id ?? ''}`));
    expect(dead.data).toMatchObject({
      queue: 'automation',
      jobId: id,
      failedReason: 'automation exploded',
      attemptsMade: 2,
      envelope: { tenantId: small, topic: 'automation.after_save', payload: { recordId: 'r9' } },
    });
    await eventually(async () => (await w.fairness.inFlight('automation', small)) === 0);
  });
});

describe('maintenance', () => {
  it('runs the outbox partition job on start, on the cell-wide maintenance queue', async () => {
    const schedulers = await w.queues.get('maintenance').getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toContain(OUTBOX_PARTITIONS_TOPIC);
    await eventually(async () => (await w.queues.get('maintenance').getCompletedCount()) > 0);
  });

  it('rejects an unknown maintenance job', async () => {
    await expect(
      maintenanceHandler(
        {
          eventId: 'x',
          tenantId: null,
          topic: 'maintenance.unknown',
          aggregateType: null,
          aggregateId: null,
          payload: {},
          createdAt: new Date().toISOString(),
        },
        { prisma: w.prisma, logger: w.logger, job: undefined as never },
      ),
    ).rejects.toThrow(/unknown maintenance job/);
  });
});
