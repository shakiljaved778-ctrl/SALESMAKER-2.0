import type { TenantTransaction } from '@sm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assignmentEnv,
  assignRecords,
  createRecord,
  deleteRecord,
  meetSlaTimers,
  runSlaTick,
  updateRecord,
  type RecordContext,
} from '../src/index.js';
import { startHarness, type Harness } from './support.js';

const T = '01920000-0000-7000-8000-000000000d0d';
let h: Harness;
const u: Record<string, string> = {};
let reassignRule = '';
/** The harness clock: 2026-09-27T10:00:00Z, a Sunday. */
const START = new Date('2026-09-27T10:00:00Z');
const at = (minutes: number) => new Date(START.getTime() + minutes * 60_000);

beforeAll(async () => {
  h = await startHarness(T);
  for (const name of ['admin', 'boss', 'rep', 'dee']) u[name] = await h.user(name);
  await h.inTenant(async ({ prisma: p }) => {
    await p.user.update({
      where: { tenantId_id: { tenantId: T, id: u['rep'] ?? '' } },
      data: { managerId: u['boss'] ?? '' },
    });
    // The default rule hands every lead to rep; the reassignment rule to dee.
    const rule = await p.assignmentRule.create({
      data: { tenantId: T, object: 'lead', name: 'To rep', isDefault: true },
    });
    await p.assignmentRuleEntry.create({
      data: { tenantId: T, ruleId: rule.id, method: 'SPECIFIC_USER', targetUserId: u['rep'] ?? '' },
    });
    const backup = await p.assignmentRule.create({
      data: { tenantId: T, object: 'lead', name: 'To dee' },
    });
    await p.assignmentRuleEntry.create({
      data: {
        tenantId: T,
        ruleId: backup.id,
        method: 'SPECIFIC_USER',
        targetUserId: u['dee'] ?? '',
      },
    });
    reassignRule = backup.id;
    await p.slaPolicy.create({
      data: {
        tenantId: T,
        name: 'First touch in an hour',
        metric: 'FIRST_TOUCH',
        targetMinutes: 60,
        warnAtPercent: 50,
        managerAtPercent: 120,
        reassignAtPercent: 150,
        reassignRuleId: backup.id,
      },
    });
    await p.slaPolicy.create({
      data: {
        tenantId: T,
        name: 'Qualify Doha leads in a day',
        metric: 'QUALIFY',
        targetMinutes: 8 * 60,
        criteria: { field: 'city', op: 'eq', value: 'Doha' },
        warnAtPercent: null,
        managerAtPercent: null,
      },
    });
  });
});

afterAll(async () => {
  await h.dispose();
});

const as = <R>(fn: (tx: TenantTransaction, ctx: RecordContext) => Promise<R>, user = 'admin') =>
  h.inTenant(async (tx) => fn(tx, await h.context(tx, u[user] ?? '')));
const newLead = (fields: Record<string, unknown> = {}) =>
  as(
    async (tx, ctx) =>
      (
        await createRecord(
          tx,
          ctx,
          'lead',
          { fields: { last_name: 'Sla', company: 'C', ...fields } },
          { assign: { source: 'form' } },
        )
      ).id,
  );
const timers = (recordId: string) =>
  h.inTenant(({ prisma: p }) =>
    p.slaTimer.findMany({
      where: { recordId },
      include: { policy: true },
      orderBy: { startedAt: 'asc' },
    }),
  );
const tick = (minutes: number) => h.inTenant((tx) => runSlaTick(tx, at(minutes)));
const notes = (userId: string, recordId: string) =>
  h.inTenant(({ prisma: p }) =>
    p.notification.findMany({ where: { userId, recordId }, orderBy: { createdAt: 'asc' } }),
  );

describe('SLA timers (§7.3)', () => {
  it('start at assignment, for matching policies only, with the ladder precomputed', async () => {
    const id = await newLead();
    const [timer, ...rest] = await timers(id);
    expect(rest).toEqual([]);
    expect(timer).toMatchObject({
      ownerId: u['rep'],
      status: 'RUNNING',
      startedAt: START,
      warnAt: at(30),
      dueAt: at(60),
      reassignAt: at(90),
      nextActionAt: at(30),
    });
    const doha = await newLead({ city: 'Doha' });
    expect((await timers(doha)).map((t) => t.policy.metric)).toEqual(['FIRST_TOUCH', 'QUALIFY']);
    // rep was told about each assignment.
    expect((await notes(u['rep'] ?? '', id)).map((n) => n.kind)).toEqual(['assignment']);
  });

  it('walks the ladder once: warn the owner, breach, tell the manager, reassign', async () => {
    const id = await newLead();
    await h.inTenant(({ prisma: p }) =>
      p.slaTimer.updateMany({
        where: { recordId: { not: id } },
        data: { status: 'CANCELLED', nextActionAt: null },
      }),
    );
    expect(await tick(20)).toMatchObject({ warned: 0, breached: 0 });
    expect(await tick(31)).toMatchObject({ warned: 1, breached: 0 });
    expect(await tick(31)).toMatchObject({ warned: 0 });
    expect(await tick(61)).toMatchObject({ breached: 1, escalated: 0 });
    expect(await tick(73)).toMatchObject({ escalated: 1 });
    const due = await tick(91);
    expect(due.reassign).toEqual([{ object: 'lead', recordId: id, ruleId: reassignRule }]);
    const [timer] = await timers(id);
    expect(timer).toMatchObject({ status: 'BREACHED', breachedAt: at(60), nextActionAt: null });
    expect([...(timer?.stepsDone ?? [])].sort()).toEqual(['breach', 'manager', 'reassign', 'warn']);
    expect((await notes(u['rep'] ?? '', id)).map((n) => n.kind)).toEqual([
      'assignment',
      'sla_warning',
      'sla_breach',
    ]);
    expect((await notes(u['boss'] ?? '', id)).map((n) => n.kind)).toEqual(['sla_escalation']);
    // The worker reassigns through the policy's rule; the clock follows the record.
    await as((tx, ctx) =>
      assignRecords(tx, assignmentEnv(ctx), 'lead', [id], { source: 'sla', ruleId: reassignRule }),
    );
    expect((await timers(id))[0]?.ownerId).toBe(u['dee']);
  });

  it('stop on first touch and on qualification; late ones stay breached', async () => {
    const touched = await newLead();
    expect(
      await h.inTenant((tx) => meetSlaTimers(tx, 'lead', touched, 'FIRST_TOUCH', at(10))),
    ).toBe(1);
    expect((await timers(touched))[0]).toMatchObject({
      status: 'MET',
      metAt: at(10),
      nextActionAt: null,
    });
    const late = await newLead();
    await h.inTenant((tx) => meetSlaTimers(tx, 'lead', late, 'FIRST_TOUCH', at(75)));
    expect((await timers(late))[0]).toMatchObject({
      status: 'BREACHED',
      breachedAt: at(60),
      metAt: at(75),
    });
    const doha = await newLead({ city: 'Doha' });
    // The owner (rep) works the lead.
    await as(
      (tx, ctx) => updateRecord(tx, ctx, 'lead', doha, { fields: { status: 'qualified' } }, null),
      'rep',
    );
    const byMetric = Object.fromEntries(
      (await timers(doha)).map((t) => [t.policy.metric, t.status]),
    );
    expect(byMetric).toEqual({ FIRST_TOUCH: 'RUNNING', QUALIFY: 'MET' });
  });

  it('cancel when the lead is unqualified or deleted', async () => {
    const a = await newLead();
    await as(
      (tx, ctx) =>
        updateRecord(
          tx,
          ctx,
          'lead',
          a,
          { fields: { status: 'unqualified', unqualified_reason: 'no_budget' } },
          null,
        ),
      'rep',
    );
    expect((await timers(a))[0]?.status).toBe('CANCELLED');
    const b = await newLead();
    await as((tx, ctx) => deleteRecord(tx, ctx, 'lead', b), 'rep');
    expect((await timers(b))[0]?.status).toBe('CANCELLED');
  });

  it('count business time only when the policy has business hours', async () => {
    await h.inTenant(async ({ prisma: p }) => {
      const hours = await p.businessHours.create({
        data: {
          tenantId: T,
          name: 'Doha',
          timezone: 'Asia/Qatar',
          // Sunday 08:00–17:00 Doha = 05:00–14:00 UTC.
          hours: { sun: [['08:00', '17:00']], mon: [['08:00', '17:00']] },
        },
      });
      await p.slaPolicy.updateMany({
        where: { metric: 'FIRST_TOUCH' },
        data: { businessHoursId: hours.id, targetMinutes: 300 },
      });
    });
    const id = await newLead();
    // From 10:00 UTC on Sunday: 4 h left that day, 1 h on Monday from 05:00 UTC.
    expect((await timers(id))[0]?.dueAt).toEqual(new Date('2026-09-28T06:00:00Z'));
  });
});
