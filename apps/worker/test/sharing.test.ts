import { outbox, visibility } from '@sm/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { maintenanceHandler } from '../src/maintenance.js';
import {
  createSharingHandler,
  RULE_CHANGED,
  RULE_DELETED,
  sharingHandler,
  VISIBILITY_CHANGED,
} from '../src/sharing.js';
import { eventually, startTestWorker, type TestWorker } from './support.js';

let w: TestWorker;
let tenantId = '';
let boss = '';
let rep = '';

beforeAll(async () => {
  w = await startTestWorker({
    handlers: {
      sharing: createSharingHandler({ recordTable: (o) => `fx_${o}`, batchSize: 2 }),
      maintenance: maintenanceHandler,
    },
  });
  const migrator = new pg.Client({ connectionString: w.db.migratorUrl });
  await migrator.connect();
  await migrator.query(`CREATE TABLE fx_account (tenant_id uuid NOT NULL, id uuid NOT NULL
    DEFAULT uuid_generate_v7(), owner_id uuid NOT NULL, amount numeric, PRIMARY KEY (tenant_id, id));
    SELECT enable_tenant_rls('fx_account');`);
  await migrator.end();
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

describe('sharing rule jobs (§6.4)', () => {
  let ruleId = '';
  let groupId = '';

  it('recalculate a rule in batches and record progress on its job run', async () => {
    const jobRunId = await w.inTenant(tenantId, async (tx) => {
      const p = tx.prisma;
      groupId = (await p.publicGroup.create({ data: { tenantId, name: 'Big deals' } })).id;
      ruleId = (
        await p.sharingRule.create({
          data: {
            tenantId,
            object: 'account',
            name: 'big deals',
            kind: 'CRITERIA',
            criteria: { field: 'amount', op: 'gte', value: 1000 },
            targetType: 'GROUP',
            targetId: groupId,
            access: 1,
          },
        })
      ).id;
      await tx.kysely
        .insertInto('fx_account')
        .values(
          [10, 1000, 5000, 20].map((amount) => ({ tenant_id: tenantId, owner_id: rep, amount })),
        )
        .execute();
      const run = await p.jobRun.create({
        data: { tenantId, kind: RULE_CHANGED, subjectId: ruleId },
      });
      await outbox.emit(tx, { topic: RULE_CHANGED, payload: { ruleId, jobRunId: run.id } });
      return run.id;
    });
    const run = await eventually(async () => {
      const r = await w.inTenant(tenantId, (tx) =>
        tx.prisma.jobRun.findUniqueOrThrow({ where: { tenantId_id: { tenantId, id: jobRunId } } }),
      );
      return r.status === 'SUCCEEDED' ? r : undefined;
    });
    expect(run).toMatchObject({ done: 4, total: 4, error: null });
    expect(run.startedAt).toBeInstanceOf(Date);
    const shares = await w.inTenant(tenantId, (tx) =>
      tx.prisma.recordShare.count({ where: { sourceId: ruleId } }),
    );
    expect(shares).toBe(2);
  });

  it('creates a job run when none was given, and ignores a rule deleted meanwhile', async () => {
    await w.inTenant(tenantId, async (tx) => {
      await outbox.emit(tx, { topic: RULE_CHANGED, payload: { ruleId } });
      await outbox.emit(tx, {
        topic: RULE_CHANGED,
        payload: { ruleId: '01920000-0000-7000-8000-00000000dead' },
      });
    });
    await eventually(async () =>
      w.inTenant(
        tenantId,
        async (tx) =>
          (await tx.prisma.jobRun.count({ where: { subjectId: ruleId, status: 'SUCCEEDED' } })) ===
          2,
      ),
    );
  });

  it('removes a deleted rule’s shares', async () => {
    await w.inTenant(tenantId, async (tx) => {
      await tx.prisma.sharingRule.delete({ where: { tenantId_id: { tenantId, id: ruleId } } });
      await outbox.emit(tx, { topic: RULE_DELETED, payload: { ruleId, object: 'account' } });
    });
    await eventually(async () =>
      w.inTenant(
        tenantId,
        async (tx) => (await tx.prisma.recordShare.count({ where: { sourceId: ruleId } })) === 0,
      ),
    );
  });

  it('marks the job run failed when recalculation fails', async () => {
    const jobRunId = await w.inTenant(tenantId, async (tx) => {
      const broken = await tx.prisma.sharingRule.create({
        data: {
          tenantId,
          object: 'nothing', // no fx_nothing table
          name: 'broken',
          kind: 'OWNER',
          sourceType: 'GROUP',
          sourceId: groupId,
          targetType: 'GROUP',
          targetId: groupId,
          access: 1,
        },
      });
      const run = await tx.prisma.jobRun.create({
        data: { tenantId, kind: RULE_CHANGED, subjectId: broken.id },
      });
      await outbox.emit(tx, {
        topic: RULE_CHANGED,
        payload: { ruleId: broken.id, jobRunId: run.id },
      });
      return run.id;
    });
    const run = await eventually(async () => {
      const r = await w.inTenant(tenantId, (tx) =>
        tx.prisma.jobRun.findUniqueOrThrow({ where: { tenantId_id: { tenantId, id: jobRunId } } }),
      );
      return r.status === 'FAILED' ? r : undefined;
    }, 20_000);
    expect(run.error).toMatch(/fx_nothing/);
  });
});
