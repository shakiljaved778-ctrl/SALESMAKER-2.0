import { outbox, visibility } from '@sm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { maintenanceHandler } from '../src/maintenance.js';
import { sharingHandler, VISIBILITY_CHANGED } from '../src/sharing.js';
import { eventually, startTestWorker, type TestWorker } from './support.js';

let w: TestWorker;
let tenantId = '';
let boss = '';
let rep = '';

beforeAll(async () => {
  w = await startTestWorker({
    handlers: { sharing: sharingHandler, maintenance: maintenanceHandler },
  });
  tenantId = await w.tenant('vis');
  await w.inTenant(tenantId, async ({ prisma }) => {
    await prisma.tenantSettings.create({
      data: {
        tenantId,
        name: 'vis',
        slug: 'vis',
        region: 'eu-central-1',
        corporateCurrency: 'USD',
        defaultTimezone: 'UTC',
      },
    });
    boss = (await prisma.user.create({ data: { tenantId, email: 'boss@vis.test', name: 'Boss' } }))
      .id;
    rep = (
      await prisma.user.create({
        data: { tenantId, email: 'rep@vis.test', name: 'Rep', managerId: boss },
      })
    ).id;
  });
  await w.start();
});

afterAll(async () => {
  await w.dispose();
});

describe('sharing jobs (§6.4)', () => {
  it('rebuild owner visibility for the viewers named, from an outbox event', async () => {
    await w.inTenant(tenantId, (tx) =>
      outbox.emit(tx, { topic: VISIBILITY_CHANGED, payload: { viewers: [boss] } }),
    );
    await eventually(async () => {
      const owners = await w.inTenant(tenantId, (tx) => visibility.ownersVisibleTo(tx, boss));
      return owners.includes(rep);
    });
    expect(await w.inTenant(tenantId, (tx) => visibility.ownersVisibleTo(tx, rep))).toEqual([]);
  });

  it('rebuild every viewer when none are named', async () => {
    await w.inTenant(tenantId, (tx) => outbox.emit(tx, { topic: VISIBILITY_CHANGED }));
    await eventually(async () => {
      const owners = await w.inTenant(tenantId, (tx) => visibility.ownersVisibleTo(tx, rep));
      return owners.length === 1;
    });
  });

  it('dead-letter a malformed or unknown sharing job', async () => {
    const [bad] = await w.inTenant(tenantId, (tx) =>
      outbox.emit(tx, { topic: VISIBILITY_CHANGED, payload: { viewers: ['not-a-uuid'] } }),
    );
    const [unknown] = await w.inTenant(tenantId, (tx) =>
      outbox.emit(tx, { topic: 'sharing.something_else' }),
    );
    for (const id of [bad, unknown])
      await eventually(async () => w.queues.deadLetter.getJob(`sharing.${id ?? ''}`), 20_000);
  });

  it('refuse a sharing job without a tenant', async () => {
    await expect(
      sharingHandler(
        {
          eventId: 'x',
          tenantId: null,
          topic: VISIBILITY_CHANGED,
          aggregateType: null,
          aggregateId: null,
          payload: {},
          createdAt: new Date().toISOString(),
        },
        { prisma: w.prisma, logger: w.logger, job: undefined as never },
      ),
    ).rejects.toThrow(/needs a tenant/);
  });
});
