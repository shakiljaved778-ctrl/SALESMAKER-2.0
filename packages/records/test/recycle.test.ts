import type { TenantTransaction } from '@sm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assignmentEnv,
  bulkInsert,
  readStored,
  recycleLeads,
  type RecordContext,
} from '../src/index.js';
import { startHarness, type Harness } from './support.js';

const T = '01920000-0000-7000-8000-000000000d0e';
let h: Harness;
const u: Record<string, string> = {};
let ruleId = '';
const DAY = 86_400_000;

beforeAll(async () => {
  h = await startHarness(T);
  for (const n of ['rep', 'dee']) u[n] = await h.user(n);
  ruleId = await h.inTenant(async ({ prisma: p }) => {
    const assign = await p.assignmentRule.create({
      data: { tenantId: T, object: 'lead', name: 'To dee' },
    });
    await p.assignmentRuleEntry.create({
      data: {
        tenantId: T,
        ruleId: assign.id,
        method: 'SPECIFIC_USER',
        targetUserId: u['dee'] ?? '',
      },
    });
    const rule = await p.recycleRule.create({
      data: {
        tenantId: T,
        name: 'Back after 30 days',
        fromCategories: ['UNQUALIFIED', 'NURTURE'],
        afterDays: 30,
        criteria: { field: 'city', op: 'ne', value: 'Nowhere' },
        targetStatus: 'open',
        assignmentRuleId: assign.id,
      },
    });
    return rule.id;
  });
});

afterAll(async () => {
  await h.dispose();
});

const withCtx = <R>(fn: (tx: TenantTransaction, ctx: RecordContext) => Promise<R>) =>
  h.inTenant(async (tx) => fn(tx, await h.context(tx, u['rep'] ?? '')));

describe('lead recycling (§7.3)', () => {
  it('returns stale unqualified and nurture leads to open and routes them again, once', async () => {
    const ids = await withCtx(async (tx, ctx) =>
      (
        await bulkInsert(tx, ctx, 'lead', [
          {
            fields: {
              last_name: 'Stale',
              company: 'C',
              status: 'unqualified',
              unqualified_reason: 'no_budget',
              city: 'Doha',
            },
          },
          { fields: { last_name: 'Nurture', company: 'C', status: 'nurture', city: 'Doha' } },
          { fields: { last_name: 'Working', company: 'C', status: 'working', city: 'Doha' } },
          { fields: { last_name: 'Excluded', company: 'C', status: 'nurture', city: 'Nowhere' } },
        ])
      ).map((r) => (r.ok ? r.id : '')),
    );
    const later = (days: number) => () => new Date(Date.now() + days * DAY);
    const run = (days: number) =>
      withCtx((tx, ctx) =>
        recycleLeads(tx, { ...assignmentEnv(ctx), actorId: null, now: later(days) }, ruleId),
      );
    expect(await run(10)).toBe(0);
    expect(await run(31)).toBe(2);
    const state = await withCtx(async (tx, ctx) => {
      const meta = ctx.metadata.object('lead');
      if (!meta) throw new Error('lead');
      return Promise.all(ids.map(async (id) => (await readStored(tx, meta, id))?.values));
    });
    expect(state.map((v) => [v?.['status'], v?.['owner_id']])).toEqual([
      ['open', u['dee']],
      ['open', u['dee']],
      ['working', u['rep']],
      ['nurture', u['rep']],
    ]);
    expect(state[0]?.['unqualified_reason']).toBeNull();
    const log = await h.inTenant(({ prisma: p }) =>
      p.assignmentLog.findFirstOrThrow({ where: { recordId: ids[0] ?? '' } }),
    );
    expect(log).toMatchObject({ source: 'recycle', ownerId: u['dee'] });
    const audited = await h.inTenant(({ prisma: p }) =>
      p.auditLog.count({ where: { action: 'record.recycled' } }),
    );
    expect(audited).toBe(2);
    // Just touched: nothing more to recycle.
    expect(await run(31)).toBe(0);
  });

  it('does nothing for an inactive rule', async () => {
    await h.inTenant(({ prisma: p }) => p.recycleRule.updateMany({ data: { active: false } }));
    expect(
      await withCtx((tx, ctx) =>
        recycleLeads(
          tx,
          { ...assignmentEnv(ctx), now: () => new Date(Date.now() + 400 * DAY) },
          ruleId,
        ),
      ),
    ).toBe(0);
  });
});
