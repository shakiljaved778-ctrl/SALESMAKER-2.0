import { outbox } from '@sm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { eventually, startTestWorker, type TestWorker } from './support.js';

let w: TestWorker;
let acme = '';
let globex = '';

beforeAll(async () => {
  // No consumers: jobs stay in their queues where the tests can inspect them.
  w = await startTestWorker({ handlers: {} });
  acme = await w.tenant('acme');
  globex = await w.tenant('globex');
});

afterAll(async () => {
  await w.dispose();
});

describe('OutboxRelay.drain (§3.7, §3.9)', () => {
  it('enqueues each event on its topic’s queue with the event id as job id, then marks it published', async () => {
    const [id] = await w.inTenant(acme, (tx) =>
      outbox.emit(tx, {
        topic: 'sharing.owner_changed',
        payload: { recordId: 'r1' },
        aggregateType: 'lead',
        aggregateId: '01920000-0000-7000-8000-000000000001',
      }),
    );
    expect(await w.relay.drain(acme)).toBe(1);
    const job = await w.queues.get('sharing').getJob(id ?? '');
    expect(job?.name).toBe('sharing.owner_changed');
    expect(job?.data).toMatchObject({
      eventId: id,
      tenantId: acme,
      topic: 'sharing.owner_changed',
      aggregateType: 'lead',
      payload: { recordId: 'r1' },
    });
    expect(job?.opts.priority).toBe(1);
    expect(await w.inTenant(acme, (tx) => outbox.claim(tx))).toEqual([]);
    expect(await w.relay.drain(acme)).toBe(0);
  });

  it('publishes more than one batch and gives a tenant’s later jobs lower priority', async () => {
    const small = await startTestWorker({ handlers: {}, config: { RELAY_BATCH: 2 } });
    try {
      const tenant = await small.tenant('batchy');
      const ids = await small.inTenant(tenant, (tx) =>
        outbox.emit(
          tx,
          Array.from({ length: 5 }, (_, i) => ({ topic: 'index.record_changed', payload: { i } })),
        ),
      );
      expect(await small.relay.drain(tenant)).toBe(5);
      const priorities = await Promise.all(
        ids.map(async (id) => (await small.queues.get('index').getJob(id))?.opts.priority),
      );
      expect(priorities).toEqual([1, 2, 3, 4, 5]);
      expect(await small.fairness.inFlight('index', tenant)).toBe(5);
    } finally {
      await small.dispose();
    }
  });

  it('does not enqueue a replayed event twice', async () => {
    const [id] = await w.inTenant(globex, (tx) =>
      outbox.emit(tx, { topic: 'index.record_changed' }),
    );
    await w.relay.drain(globex);
    const before = await w.fairness.inFlight('index', globex);
    // Simulate a lost commit: the event is unpublished again although its job exists.
    await w.inTenant(globex, (tx) =>
      tx.prisma.outboxEvent.updateMany({ where: { id: id ?? '' }, data: { publishedAt: null } }),
    );
    expect(await w.relay.drain(globex)).toBe(1);
    expect(await w.fairness.inFlight('index', globex)).toBe(before);
    expect(await w.queues.get('index').getJobCountByTypes('prioritized', 'waiting')).toBe(1);
  });

  it('coalesces concurrent drains of one tenant', async () => {
    await w.inTenant(acme, (tx) =>
      outbox.emit(tx, [{ topic: 'index.a' }, { topic: 'index.b' }, { topic: 'index.c' }]),
    );
    const results = await Promise.all([w.relay.drain(acme), w.relay.drain(acme)]);
    expect(results[0]).toBe(results[1]);
    expect(results[0]).toBe(3);
  });
});

describe('OutboxRelay.sweep and start', () => {
  it('sweeps every tenant the control plane lists, page by page', async () => {
    const original = w.controlPlane.listCellTenants.bind(w.controlPlane);
    w.controlPlane.listCellTenants = (options = {}) => original({ ...options, limit: 1 });
    try {
      await w.inTenant(acme, (tx) => outbox.emit(tx, { topic: 'reports.run' }));
      await w.inTenant(globex, (tx) => outbox.emit(tx, { topic: 'reports.run' }));
      expect(await w.relay.sweep()).toBe(2);
      expect(await w.relay.sweep()).toBe(0);
    } finally {
      w.controlPlane.listCellTenants = original;
    }
  });

  it('publishes events emitted before start, then reacts to commits without a sweep', async () => {
    const [early] = await w.inTenant(acme, (tx) => outbox.emit(tx, { topic: 'export.requested' }));
    await w.relay.start();
    try {
      expect(await w.queues.get('export').getJob(early ?? '')).toBeTruthy();
      const [late] = await w.inTenant(globex, (tx) =>
        outbox.emit(tx, { topic: 'export.requested' }),
      );
      await eventually(async () => w.queues.get('export').getJob(late ?? ''));
    } finally {
      await w.relay.stop();
    }
  });

  it('keeps sweeping when the control plane is down, and says so', async () => {
    w.controlPlane.unavailable = true;
    try {
      await expect(w.relay.sweep()).rejects.toThrow(/unavailable/);
      await w.relay.start(); // start() logs the failed sweep instead of throwing
      await w.relay.stop();
    } finally {
      w.controlPlane.unavailable = false;
    }
  });
});
