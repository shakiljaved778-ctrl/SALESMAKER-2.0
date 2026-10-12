import type { TenantTransaction } from '@sm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRecord,
  nextRun,
  runDueDuplicateJobs,
  runDuplicateJob,
  type RecordContext,
} from '../src/index.js';
import { startHarness, type Harness } from './support.js';

const T = '01920000-0000-7000-8000-000000000d0b';
let h: Harness;
let rep = '';
let ruleId = '';

beforeAll(async () => {
  h = await startHarness(T);
  rep = await h.user('rep');
  ruleId = await h.inTenant(async ({ prisma: p }) => {
    const rule = await p.matchingRule.create({
      data: {
        tenantId: T,
        object: 'lead',
        name: 'Phone',
        conditions: [{ field: 'phone', method: 'phone' }] as never,
      },
    });
    return rule.id;
  });
});

afterAll(async () => {
  await h.dispose();
});

const as = <R>(fn: (tx: TenantTransaction, ctx: RecordContext) => Promise<R>) =>
  h.inTenant(async (tx) => fn(tx, await h.context(tx, rep)));
const lead = async (fields: Record<string, unknown>) =>
  (await as((tx, ctx) => createRecord(tx, ctx, 'lead', { fields }))).id;
const job = (schedule: string | null = null) =>
  h.inTenant(
    async ({ prisma: p }) =>
      (
        await p.duplicateJob.create({
          data: { tenantId: T, object: 'lead', matchingRuleId: ruleId, schedule },
        })
      ).id,
  );
const candidates = () =>
  h.inTenant(({ prisma: p }) => p.duplicateCandidate.findMany({ orderBy: { groupKey: 'asc' } }));

describe('duplicate jobs (§7.2)', () => {
  it('scans in batches and queues every matching pair once, phone against mobile too', async () => {
    const a = await lead({ last_name: 'A', company: 'C', phone: '+974 5550 0001' });
    const b = await lead({ last_name: 'B', company: 'C', mobile_phone: '55500001' });
    const c = await lead({ last_name: 'C', company: 'C', phone: '5550 0001' });
    await lead({ last_name: 'D', company: 'C', phone: '5550 0002' });
    await lead({ last_name: 'E', company: 'C' });
    const id = await job();
    expect(await runDuplicateJob((fn) => h.inTenant(fn), id, { batch: 2 })).toEqual({
      scanned: 5,
      found: 3,
    });
    const sorted = (x: string, y: string) => [x, y].sort().join(',');
    expect((await candidates()).map((c2) => c2.groupKey).sort()).toEqual(
      [sorted(a, b), sorted(a, c), sorted(b, c)].sort(),
    );
    const done = await h.inTenant(({ prisma: p }) =>
      p.duplicateJob.findFirstOrThrow({ where: { id } }),
    );
    expect(done).toMatchObject({ status: 'SUCCEEDED', scanned: 5, found: 3, nextRunAt: null });
    // A job runs once; running it again does nothing.
    expect(await runDuplicateJob((fn) => h.inTenant(fn), id)).toBeNull();
  });

  it('never re-queues known pairs, dismissed ones included', async () => {
    await h.inTenant(({ prisma: p }) =>
      p.duplicateCandidate.updateMany({ data: { status: 'DISMISSED' } }),
    );
    const id = await job();
    expect(await runDuplicateJob((fn) => h.inTenant(fn), id)).toEqual({ scanned: 5, found: 0 });
    expect((await candidates()).every((c) => c.status === 'DISMISSED')).toBe(true);
  });

  it('runs scheduled jobs when due and plans the next run', async () => {
    const now = new Date('2026-10-12T08:00:00Z');
    expect(nextRun('daily', now)?.toISOString()).toBe('2026-10-13T08:00:00.000Z');
    expect(nextRun('weekly', now)?.toISOString()).toBe('2026-10-19T08:00:00.000Z');
    expect(nextRun(null, now)).toBeNull();
    const id = await job('daily');
    await runDuplicateJob((fn) => h.inTenant(fn), id, { now: () => now });
    // Not due yet; then due a day later.
    expect(await runDueDuplicateJobs((fn) => h.inTenant(fn), { now: () => now })).toBe(0);
    const later = new Date('2026-10-13T09:00:00Z');
    expect(await runDueDuplicateJobs((fn) => h.inTenant(fn), { now: () => later })).toBe(1);
    const row = await h.inTenant(({ prisma: p }) =>
      p.duplicateJob.findFirstOrThrow({ where: { id } }),
    );
    expect(row.nextRunAt?.toISOString()).toBe('2026-10-14T09:00:00.000Z');
  });
});
