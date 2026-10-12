import { audit, outbox, type TenantTransaction } from '@sm/db';
import type { MetadataIndex, ObjectMeta } from '@sm/metadata';
import { fieldExpr, filterSqlWith, type FilterNode } from '@sm/query-engine';
import { sql } from 'kysely';

import { addBusinessMinutes, ALWAYS_OPEN, type Calendar } from './calendar.js';
import { loadCalendar } from './calendars.js';
import { ident } from './storage.js';

/*
 * SLA timers (§7.3, P03 T13): a policy's clock starts when a record is assigned and its ladder
 * instants (warn the owner, breach at 100 %, tell the manager, reassign) are computed once, in
 * UTC, with business-time arithmetic. A worker tick acts on each due step exactly once
 * (`steps_done`); first touch and qualification stop the clock.
 */

export const SLA_TICK_TOPIC = 'maintenance.sla_tick';
export type SlaStep = 'warn' | 'breach' | 'manager' | 'reassign';

interface Policy {
  id: string;
  name: string;
  object: string;
  metric: 'FIRST_TOUCH' | 'QUALIFY';
  targetMinutes: number;
  businessHoursId: string | null;
  ownerTimezone: boolean;
  criteria: unknown;
  warnAtPercent: number | null;
  managerAtPercent: number | null;
  reassignAtPercent: number | null;
  reassignRuleId: string | null;
}

/** The instant of each step a policy has, for a clock started at `start`. */
export function stepInstants(
  policy: Pick<
    Policy,
    'targetMinutes' | 'warnAtPercent' | 'managerAtPercent' | 'reassignAtPercent' | 'reassignRuleId'
  >,
  calendar: Calendar,
  start: Date,
): Partial<Record<SlaStep, Date>> {
  const at = (percent: number) =>
    addBusinessMinutes(start, Math.round((policy.targetMinutes * percent) / 100), calendar) ??
    // A calendar that never opens: count every minute instead of never acting.
    addBusinessMinutes(start, Math.round((policy.targetMinutes * percent) / 100), ALWAYS_OPEN) ??
    start;
  const out: Partial<Record<SlaStep, Date>> = { breach: at(100) };
  if (policy.warnAtPercent) out.warn = at(policy.warnAtPercent);
  if (policy.managerAtPercent) out.manager = at(policy.managerAtPercent);
  if (policy.reassignAtPercent && policy.reassignRuleId)
    out.reassign = at(policy.reassignAtPercent);
  return out;
}

const nextAction = (steps: Partial<Record<SlaStep, Date>>, done: readonly string[]) => {
  const pending = Object.entries(steps)
    .filter(([step]) => !done.includes(step))
    .map(([, at]) => at.getTime());
  return pending.length ? new Date(Math.min(...pending)) : null;
};

async function calendarFor(
  tx: TenantTransaction,
  policy: Policy,
  ownerId: string,
  cache: Map<string, Promise<Calendar>>,
): Promise<Calendar> {
  let base = cache.get(policy.businessHoursId ?? '');
  if (!base) {
    base = loadCalendar(tx, policy.businessHoursId);
    cache.set(policy.businessHoursId ?? '', base);
  }
  const calendar = await base;
  if (!policy.ownerTimezone) return calendar;
  const owner = await tx.prisma.user.findFirst({
    where: { id: ownerId },
    select: { timezone: true },
  });
  return owner?.timezone ? { ...calendar, timezone: owner.timezone } : calendar;
}

/**
 * After records were assigned (§7.3): start each matching active policy's clock on records that
 * never had one for it, and move running timers to the new owner (the clock keeps running).
 */
export async function startSlaTimers(
  tx: TenantTransaction,
  metadata: MetadataIndex,
  object: ObjectMeta,
  assigned: readonly { recordId: string; ownerId: string }[],
  now: Date,
): Promise<number> {
  if (assigned.length === 0) return 0;
  const tenantId = tx.context.tenantId;
  for (const a of assigned)
    await tx.prisma.slaTimer.updateMany({
      // Open clocks (running, or breached and not yet met) follow the record to its new owner.
      where: {
        object: object.apiName,
        recordId: a.recordId,
        status: { in: ['RUNNING', 'BREACHED'] },
        metAt: null,
      },
      data: { ownerId: a.ownerId, version: { increment: 1 } },
    });
  const policies = (await tx.prisma.slaPolicy.findMany({
    where: { object: object.apiName, active: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })) as Policy[];
  const calendars = new Map<string, Promise<Calendar>>();
  let started = 0;
  const ids = assigned.map((a) => a.recordId);
  for (const policy of policies) {
    let matching = ids;
    if (policy.criteria) {
      const column = (name: string) => {
        const f = object.fields.find((x) => x.apiName === name);
        if (!f) throw new Error(`unknown field ${name}`);
        return fieldExpr('r', f);
      };
      let where;
      try {
        where = filterSqlWith(column, policy.criteria as FilterNode);
      } catch {
        continue; // A policy whose criteria no longer compile starts nothing.
      }
      matching = (
        await sql<{ id: string }>`SELECT r.id FROM ${sql.table(ident(object.table))} AS r
          WHERE r.tenant_id = ${tenantId}::uuid AND r.id = ANY (${sql.val(ids)}::uuid[]) AND ${where}`.execute(
          tx.kysely,
        )
      ).rows.map((r) => r.id);
    }
    if (matching.length === 0) continue;
    const existing = new Set(
      (
        await tx.prisma.slaTimer.findMany({
          where: { policyId: policy.id, recordId: { in: matching }, status: { not: 'CANCELLED' } },
          select: { recordId: true },
        })
      ).map((t) => t.recordId),
    );
    const rows = [];
    for (const a of assigned) {
      if (!matching.includes(a.recordId) || existing.has(a.recordId)) continue;
      const calendar = await calendarFor(tx, policy, a.ownerId, calendars);
      const steps = stepInstants(policy, calendar, now);
      rows.push({
        tenantId,
        policyId: policy.id,
        object: object.apiName,
        recordId: a.recordId,
        ownerId: a.ownerId,
        startedAt: now,
        warnAt: steps.warn ?? null,
        dueAt: steps.breach ?? now,
        reassignAt: steps.reassign ?? null,
        nextActionAt: nextAction(steps, []),
      });
    }
    if (rows.length) await tx.prisma.slaTimer.createMany({ data: rows });
    started += rows.length;
  }
  return started;
}

/**
 * Stop the clocks a record's progress meets (§7.3): FIRST_TOUCH on a touch (a call, email or
 * message logged; `POST …/touch`), QUALIFY when a lead is qualified or converted. A clock
 * stopped after its due time stays BREACHED, with the time it was met.
 */
export async function meetSlaTimers(
  tx: TenantTransaction,
  object: string,
  recordId: string,
  metric: 'FIRST_TOUCH' | 'QUALIFY',
  now: Date,
): Promise<number> {
  const timers = await tx.prisma.slaTimer.findMany({
    where: {
      object,
      recordId,
      status: { in: ['RUNNING', 'BREACHED'] },
      metAt: null,
      policy: { metric },
    },
  });
  for (const t of timers)
    await tx.prisma.slaTimer.update({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id: t.id } },
      data: {
        status: t.status === 'RUNNING' && now <= t.dueAt ? 'MET' : 'BREACHED',
        metAt: now,
        ...(t.status === 'RUNNING' && now > t.dueAt ? { breachedAt: t.dueAt } : {}),
        nextActionAt: null,
        version: { increment: 1 },
      },
    });
  return timers.length;
}

/** A record that leaves play (deleted, unqualified) stops its running clocks. */
export async function cancelSlaTimers(
  tx: TenantTransaction,
  object: string,
  recordIds: readonly string[],
): Promise<number> {
  const { count } = await tx.prisma.slaTimer.updateMany({
    where: { object, recordId: { in: [...recordIds] }, status: 'RUNNING' },
    data: { status: 'CANCELLED', nextActionAt: null, version: { increment: 1 } },
  });
  return count;
}

export interface SlaTickResult {
  warned: number;
  breached: number;
  escalated: number;
  reassign: { object: string; recordId: string; ruleId: string }[];
}

/**
 * Act on every running timer whose next step is due (the worker's minute tick), in batches
 * claimed with SKIP LOCKED so overlapping ticks never act twice. Notifications for owners and
 * managers, breaches, and the records due for reassignment (run by the caller through the
 * assignment engine with the policy's rule).
 */
export async function runSlaTick(
  tx: TenantTransaction,
  now: Date,
  options: { batch?: number } = {},
): Promise<SlaTickResult> {
  const result: SlaTickResult = { warned: 0, breached: 0, escalated: 0, reassign: [] };
  const due = await sql<{ id: string }>`
    SELECT id FROM sla_timer
    WHERE tenant_id = ${tx.context.tenantId}::uuid AND status IN ('RUNNING', 'BREACHED')
      AND next_action_at <= ${now.toISOString()}::timestamptz
    ORDER BY next_action_at LIMIT ${options.batch ?? 500}
    FOR UPDATE SKIP LOCKED`.execute(tx.kysely);
  if (due.rows.length === 0) return result;
  const timers = await tx.prisma.slaTimer.findMany({
    where: { id: { in: due.rows.map((r) => r.id) } },
    include: { policy: true },
  });
  const calendars = new Map<string, Promise<Calendar>>();
  const notifications: {
    userId: string;
    kind: string;
    params: Record<string, unknown>;
    object: string;
    recordId: string;
  }[] = [];
  const managers = new Map<string, string | null>();
  const managerOf = async (userId: string) => {
    if (!managers.has(userId))
      managers.set(
        userId,
        (await tx.prisma.user.findFirst({ where: { id: userId }, select: { managerId: true } }))
          ?.managerId ?? null,
      );
    return managers.get(userId) ?? null;
  };
  const isUser = async (id: string) =>
    Boolean(await tx.prisma.user.findFirst({ where: { id }, select: { id: true } }));
  for (const timer of timers) {
    const policy = timer.policy as unknown as Policy;
    const calendar = await calendarFor(tx, policy, timer.ownerId, calendars);
    const steps = stepInstants(policy, calendar, timer.startedAt);
    const done = [...timer.stepsDone];
    let status = timer.status;
    let breachedAt = timer.breachedAt;
    const params = { policy: policy.name, targetMinutes: policy.targetMinutes };
    const owner = (await isUser(timer.ownerId)) ? timer.ownerId : null;
    for (const [step, at] of Object.entries(steps) as [SlaStep, Date][]) {
      if (done.includes(step) || at > now) continue;
      done.push(step);
      if (step === 'warn' && status === 'RUNNING' && owner) {
        notifications.push({
          userId: owner,
          kind: 'sla_warning',
          params,
          object: timer.object,
          recordId: timer.recordId,
        });
        result.warned += 1;
      }
      if (step === 'breach' && status === 'RUNNING') {
        status = 'BREACHED';
        breachedAt = at;
        result.breached += 1;
        if (owner)
          notifications.push({
            userId: owner,
            kind: 'sla_breach',
            params,
            object: timer.object,
            recordId: timer.recordId,
          });
      }
      if (step === 'manager' && owner) {
        const manager = await managerOf(owner);
        if (manager) {
          notifications.push({
            userId: manager,
            kind: 'sla_escalation',
            params: { ...params, ownerId: owner },
            object: timer.object,
            recordId: timer.recordId,
          });
          result.escalated += 1;
        }
      }
      if (step === 'reassign' && policy.reassignRuleId)
        result.reassign.push({
          object: timer.object,
          recordId: timer.recordId,
          ruleId: policy.reassignRuleId,
        });
    }
    await tx.prisma.slaTimer.update({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id: timer.id } },
      data: {
        stepsDone: done,
        status,
        breachedAt,
        nextActionAt: nextAction(steps, done),
        version: { increment: 1 },
      },
    });
  }
  await notify(tx, notifications);
  if (result.breached)
    await audit.recordMany(
      tx,
      timers
        .filter((t) => t.status === 'RUNNING')
        .flatMap((t) =>
          t.dueAt <= now
            ? [
                {
                  action: 'sla.breached',
                  object: t.object,
                  recordId: t.recordId,
                  payload: { policyId: t.policyId },
                  actorType: 'system' as const,
                },
              ]
            : [],
        ),
    );
  return result;
}

/** In-app notifications (§7.18 minimal, P03 T14): one row each, and a realtime nudge per user. */
export async function notify(
  tx: TenantTransaction,
  rows: readonly {
    userId: string;
    kind: string;
    params?: Record<string, unknown>;
    object?: string | null;
    recordId?: string | null;
  }[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const tenantId = tx.context.tenantId;
  await tx.prisma.notification.createMany({
    data: rows.map((r) => ({
      tenantId,
      userId: r.userId,
      kind: r.kind,
      params: (r.params ?? {}) as never,
      object: r.object ?? null,
      recordId: r.recordId ?? null,
    })),
  });
  await outbox.emit(
    tx,
    [...new Set(rows.map((r) => r.userId))].map((userId) => ({
      topic: 'automation.notification_created',
      aggregateType: 'user',
      aggregateId: userId,
      payload: { userId },
    })),
  );
  return rows.length;
}
