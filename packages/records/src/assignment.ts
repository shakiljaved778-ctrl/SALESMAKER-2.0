import { audit, membership, outbox, type TenantTransaction } from '@sm/db';
import { checkFormula, compileToSql, metadataEnvironment } from '@sm/formula';
import type { MetadataIndex, ObjectMeta } from '@sm/metadata';
import {
  evaluateRulesForRecords,
  fieldExpr,
  filterSqlWith,
  type FilterNode,
} from '@sm/query-engine';
import { sql, type RawBuilder } from 'kysely';

import { isOpen, localParts, type WeeklyHours } from './calendar.js';
import { activeRules } from './service.js';
import { notify, startSlaTimers } from './sla.js';
import { syncAccountShares, syncOpportunityShares } from './shares.js';
import { ident } from './storage.js';

/*
 * Assignment rules (§7.3, P03 T10): the first active entry of the object's rule whose criteria
 * match a record decides its owner, by one of seven methods over a pool of users. Deterministic
 * and auditable: every decision writes an assignment_log row with the candidates and why each
 * was skipped. Works on a batch at a time: criteria in one statement per entry, cursors locked
 * once per entry and batch (so concurrent imports and forms never hand out the same turn), owners
 * written set-based with history, audit, events and shares.
 */

export const ASSIGNMENT_OBJECTS = ['lead', 'contact', 'account', 'opportunity'] as const;
export type AssignmentMethod =
  | 'ROUND_ROBIN'
  | 'WEIGHTED'
  | 'LOAD_BALANCED'
  | 'SKILLS_BASED'
  | 'STICKY_ACCOUNT'
  | 'QUEUE'
  | 'SPECIFIC_USER';

export interface EntrySettings {
  /** LOAD_BALANCED and capacity: lead status categories counted as open (default OPEN, WORKING, NURTURE). */
  openCategories?: string[];
  /** SKILLS_BASED: tags every chosen user must have. */
  skills?: string[];
  /** SKILLS_BASED: a field whose value is also required, as `<field>:<value>` (e.g. language:ar). */
  skillField?: string;
  /** Who gets the record when nobody in the pool is available; otherwise the owner is kept. */
  fallback?: { type: 'USER' | 'QUEUE'; id: string };
}

export interface AssignmentEnv {
  metadata: MetadataIndex;
  /** Who runs the rules (null: the platform, e.g. an SLA escalation). */
  actorId: string | null;
  requestId?: string;
  now?: () => Date;
  /** The organisation's time zone, for daily limits and formulas. */
  timezone: string;
}

export interface AssignmentOutcome {
  recordId: string;
  ownerType: 'USER' | 'QUEUE';
  ownerId: string;
  previousOwnerId: string | null;
  entryId: string | null;
  method: AssignmentMethod | null;
  reason: string;
  /** False when the owner was kept (nobody available, no fallback). */
  changed: boolean;
}

interface Entry {
  id: string;
  sortOrder: number;
  criteria: unknown;
  formula: string | null;
  method: AssignmentMethod;
  settings: EntrySettings;
  targetUserId: string | null;
  targetQueueId: string | null;
  members: {
    memberType: 'USER' | 'QUEUE' | 'ORG_UNIT';
    userId: string | null;
    queueId: string | null;
    orgUnitId: string | null;
    weight: number;
  }[];
}

interface Candidate {
  userId: string;
  skipped?: string;
}

const DEFAULT_OPEN = ['OPEN', 'WORKING', 'NURTURE'];

/** SQL for an entry's criteria over the record alias `r`; null when it cannot be compiled. */
function criteriaSql(
  object: ObjectMeta,
  env: AssignmentEnv,
  entry: Pick<Entry, 'criteria' | 'formula'>,
): RawBuilder<unknown> | null {
  const parts: RawBuilder<unknown>[] = [];
  if (entry.criteria) {
    const column = (name: string) => {
      const f = object.fields.find((x) => x.apiName === name);
      if (!f) throw new Error(`unknown field ${name}`);
      return fieldExpr('r', f);
    };
    try {
      parts.push(sql`${filterSqlWith(column, entry.criteria as FilterNode)}`);
    } catch {
      return null;
    }
  }
  if (entry.formula) {
    const checked = checkFormula(
      entry.formula,
      metadataEnvironment(env.metadata, object.apiName, { allowPriorValues: false }),
      'Boolean',
    );
    if (!checked.ok) return null;
    const compiled = compileToSql(checked.ast, {
      column: (path) => {
        const f = path.length === 1 ? object.fields.find((x) => x.apiName === path[0]) : undefined;
        return f ? fieldExpr('r', f) : null;
      },
      global: () => null,
      now: env.now?.() ?? new Date(),
      timezone: env.timezone,
    });
    if (!compiled.ok) return null;
    parts.push(sql`COALESCE(${compiled.sql}, FALSE)`);
  }
  return parts.length ? sql`(${sql.join(parts, sql` AND `)})` : sql`TRUE`;
}

/** The users an entry's pool names, in id order (users, queue members, org unit members). */
async function poolUsers(tx: TenantTransaction, entry: Entry): Promise<Map<string, number>> {
  const weights = new Map<string, number>();
  const add = (id: string, weight: number) => {
    if (!weights.has(id)) weights.set(id, weight);
  };
  for (const m of entry.members) {
    if (m.memberType === 'USER' && m.userId) add(m.userId, m.weight);
    if (m.memberType === 'QUEUE' && m.queueId)
      for (const id of await membership.queueUsers(tx, m.queueId)) add(id, m.weight);
    if (m.memberType === 'ORG_UNIT' && m.orgUnitId)
      for (const u of await tx.prisma.user.findMany({
        where: { orgUnitId: m.orgUnitId, deletedAt: null },
        select: { id: true },
      }))
        add(u.id, m.weight);
  }
  return new Map([...weights.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Per-batch state: open counts, today's new counts and cursors, updated as records are handed out. */
class Batch {
  readonly openCount = new Map<string, number>();
  readonly newToday = new Map<string, number>();
  constructor(
    readonly users: Map<
      string,
      {
        active: boolean;
        timezone: string;
        workingHours: WeeklyHours | null;
        ooo: boolean;
        skills: Set<string>;
        maxOpen: number | null;
        maxNewPerDay: number | null;
      }
    >,
  ) {}
}

async function loadUsers(
  tx: TenantTransaction,
  object: ObjectMeta,
  env: AssignmentEnv,
  ids: readonly string[],
  openPredicate: RawBuilder<unknown>,
): Promise<Batch> {
  const now = env.now?.() ?? new Date();
  const [users, availability, skills, capacity] = await Promise.all([
    tx.prisma.user.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, status: true, deactivatedAt: true, deletedAt: true, timezone: true },
    }),
    tx.prisma.userAvailability.findMany({ where: { userId: { in: [...ids] } } }),
    tx.prisma.userSkill.findMany({ where: { userId: { in: [...ids] } } }),
    tx.prisma.userCapacity.findMany({
      where: { userId: { in: [...ids] }, object: object.apiName },
    }),
  ]);
  const map: Batch['users'] = new Map();
  for (const u of users) {
    const a = availability.find((x) => x.userId === u.id);
    const c = capacity.find((x) => x.userId === u.id);
    map.set(u.id, {
      active: u.status === 'ACTIVE' && !u.deactivatedAt && !u.deletedAt,
      timezone: u.timezone ?? env.timezone,
      workingHours: (a?.workingHours ?? null) as WeeklyHours | null,
      ooo: Boolean(a?.outOfOffice && (!a.oooUntil || a.oooUntil > now)),
      skills: new Set(skills.filter((s) => s.userId === u.id).map((s) => s.skill)),
      maxOpen: c?.maxOpen ?? null,
      maxNewPerDay: c?.maxNewPerDay ?? null,
    });
  }
  const batch = new Batch(map);
  if (ids.length) {
    const open = await sql<{ owner_id: string; n: string }>`
      SELECT owner_id, count(*)::text AS n FROM ${sql.table(ident(object.table))} AS r
      WHERE r.tenant_id = ${tx.context.tenantId}::uuid AND r.owner_id = ANY (${sql.val([...ids])}::uuid[])
        AND r.deleted_at IS NULL AND ${openPredicate}
      GROUP BY owner_id`.execute(tx.kysely);
    for (const r of open.rows) batch.openCount.set(r.owner_id, Number(r.n));
    // "Today" in the organisation's zone.
    const day = localParts(now, env.timezone).date;
    const today = await sql<{ owner_id: string; n: string }>`
      SELECT owner_id, count(*)::text AS n FROM assignment_log
      WHERE tenant_id = ${tx.context.tenantId}::uuid AND object = ${object.apiName}
        AND owner_type = 'USER' AND owner_id = ANY (${sql.val([...ids])}::uuid[])
        AND assigned_at >= (${day}::date AT TIME ZONE ${env.timezone})
      GROUP BY owner_id`.execute(tx.kysely);
    for (const r of today.rows) batch.newToday.set(r.owner_id, Number(r.n));
  }
  return batch;
}

/** Why a user cannot take a record now (null: available). */
function unavailable(batch: Batch, userId: string, now: Date): string | null {
  const u = batch.users.get(userId);
  if (!u?.active) return 'inactive';
  if (u.ooo) return 'out_of_office';
  if (u.workingHours && !isOpen(now, { timezone: u.timezone, hours: u.workingHours, holidays: [] }))
    return 'outside_working_hours';
  if (u.maxOpen !== null && (batch.openCount.get(userId) ?? 0) >= u.maxOpen) return 'at_capacity';
  if (u.maxNewPerDay !== null && (batch.newToday.get(userId) ?? 0) >= u.maxNewPerDay)
    return 'daily_limit';
  return null;
}

/** What an object counts as open, for load and capacity. */
function openSql(object: ObjectMeta, env: AssignmentEnv, categories: readonly string[]) {
  if (object.apiName === 'opportunity') return sql`r.is_closed = false`;
  if (object.apiName === 'lead') {
    const values =
      env.metadata
        .field('lead', 'status')
        ?.picklistValues.filter((v) => v.category && categories.includes(v.category))
        .map((v) => v.apiValue) ?? [];
    return sql`r.converted_at IS NULL AND r.status = ANY (${sql.val(values)}::text[])`;
  }
  return sql`TRUE`;
}

/**
 * Run the object's assignment rule (the given one, else the active default) on these records
 * and write the owners it picks. Records no entry matches keep their owner and are not logged.
 * `source` says what triggered it (create, import, form, email, api, run, sla, recycle).
 */
export async function assignRecords(
  tx: TenantTransaction,
  env: AssignmentEnv,
  objectName: string,
  recordIds: readonly string[],
  options: { source: string; ruleId?: string | null },
): Promise<AssignmentOutcome[]> {
  const object = env.metadata.object(objectName);
  if (
    !object ||
    !(ASSIGNMENT_OBJECTS as readonly string[]).includes(objectName) ||
    !recordIds.length
  )
    return [];
  const rule = await tx.prisma.assignmentRule.findFirst({
    where: options.ruleId
      ? { id: options.ruleId, object: objectName }
      : { object: objectName, isDefault: true, active: true },
    include: {
      entries: {
        where: { active: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        include: { members: true },
      },
    },
  });
  if (!rule) return [];
  const now = env.now?.() ?? new Date();
  const tenantId = tx.context.tenantId;
  const table = sql.table(ident(object.table));
  const current = await sql<{
    id: string;
    owner_id: string | null;
    account_id?: string | null;
    match_company_key?: string | null;
  }>`
    SELECT r.id, r.owner_id
      ${object.fields.some((f) => f.apiName === 'account_id') ? sql`, r.account_id` : sql``}
      ${objectName === 'lead' ? sql`, r.match_company_key` : sql``}
    FROM ${table} AS r
    WHERE r.tenant_id = ${tenantId}::uuid AND r.id = ANY (${sql.val([...recordIds])}::uuid[])
      AND r.deleted_at IS NULL
    ORDER BY r.id FOR UPDATE`.execute(tx.kysely);
  const records = new Map(current.rows.map((r) => [r.id, r]));
  let remaining = [...records.keys()];
  const outcomes: AssignmentOutcome[] = [];
  const logs: {
    recordId: string;
    entry: Entry | null;
    candidates: Candidate[];
    outcome: AssignmentOutcome;
  }[] = [];

  for (const raw of rule.entries) {
    if (remaining.length === 0) break;
    const entry: Entry = {
      ...raw,
      method: raw.method,
      settings: (raw.settings ?? {}) as EntrySettings,
    };
    const criteria = criteriaSql(object, env, entry);
    if (!criteria) continue; // A broken entry never matches (Setup reports it).
    const matched = (
      await sql<{ id: string }>`
        SELECT r.id FROM ${table} AS r
        WHERE r.tenant_id = ${tenantId}::uuid AND r.id = ANY (${sql.val(remaining)}::uuid[])
          AND ${criteria}
        ORDER BY r.id`.execute(tx.kysely)
    ).rows.map((r) => r.id);
    if (matched.length === 0) continue;

    const pool = await poolUsers(tx, entry);
    const extra = [
      entry.targetUserId,
      entry.settings.fallback?.type === 'USER' ? entry.settings.fallback.id : null,
    ].filter((x): x is string => !!x);
    const open = openSql(object, env, entry.settings.openCategories ?? DEFAULT_OPEN);
    const batch = await loadUsers(tx, object, env, [...new Set([...pool.keys(), ...extra])], open);

    // The entry's cursor, locked for the batch: concurrent batches take turns in order.
    await sql`INSERT INTO round_robin_cursor (tenant_id, entry_id) VALUES (${tenantId}::uuid, ${entry.id}::uuid)
      ON CONFLICT DO NOTHING`.execute(tx.kysely);
    const cursorRow = (
      await sql<{ last_user_id: string | null; counts: Record<string, number>; turns: string }>`
        SELECT last_user_id, counts, turns::text AS turns FROM round_robin_cursor
        WHERE tenant_id = ${tenantId}::uuid AND entry_id = ${entry.id}::uuid FOR UPDATE`.execute(
        tx.kysely,
      )
    ).rows[0];
    let lastUser = cursorRow?.last_user_id ?? null;
    const counts = new Map(Object.entries(cursorRow?.counts ?? {}));
    let turns = Number(cursorRow?.turns ?? 0);

    const accountOwners = new Map<string, string>();
    if (entry.method === 'STICKY_ACCOUNT') {
      const keys = matched
        .map((id) => records.get(id))
        .flatMap((r) => (r?.match_company_key ? [r.match_company_key] : []));
      const accountIds = matched.flatMap((id) => {
        const a = records.get(id)?.account_id;
        return a ? [a] : [];
      });
      const rows = await sql<{ key: string | null; id: string; owner_id: string }>`
        SELECT DISTINCT ON (coalesce(match_company_key, id::text)) match_company_key AS key, id, owner_id
        FROM account WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL AND owner_id IS NOT NULL
          AND (match_company_key = ANY (${sql.val(keys)}::text[]) OR id = ANY (${sql.val(accountIds)}::uuid[]))
        ORDER BY coalesce(match_company_key, id::text), created_at, id`.execute(tx.kysely);
      for (const r of rows.rows) {
        if (r.key) accountOwners.set(`key:${r.key}`, r.owner_id);
        accountOwners.set(`id:${r.id}`, r.owner_id);
      }
      const owners = [...new Set(accountOwners.values())].filter((u) => !batch.users.has(u));
      if (owners.length) {
        const more = await loadUsers(tx, object, env, owners, open);
        for (const [k, v] of more.users) batch.users.set(k, v);
        for (const [k, v] of more.openCount) batch.openCount.set(k, v);
        for (const [k, v] of more.newToday) batch.newToday.set(k, v);
      }
    }

    const applied: string[] = [];
    for (const recordId of matched) {
      const record = records.get(recordId);
      const candidates: Candidate[] = [];
      let chosen: { type: 'USER' | 'QUEUE'; id: string; reason: string } | null = null;
      const check = (userId: string) => {
        const why = unavailable(batch, userId, now);
        candidates.push(why ? { userId, skipped: why } : { userId });
        return why === null;
      };
      switch (entry.method) {
        case 'QUEUE':
          if (entry.targetQueueId)
            chosen = {
              type: 'QUEUE',
              id: entry.targetQueueId,
              reason: 'Parked in the queue for pick-up',
            };
          break;
        case 'SPECIFIC_USER':
          if (entry.targetUserId && check(entry.targetUserId))
            chosen = { type: 'USER', id: entry.targetUserId, reason: 'The entry names this user' };
          break;
        case 'STICKY_ACCOUNT': {
          const owner =
            (record?.account_id ? accountOwners.get(`id:${record.account_id}`) : undefined) ??
            (record?.match_company_key
              ? accountOwners.get(`key:${record.match_company_key}`)
              : undefined);
          if (!owner) {
            // No account: this entry does not apply; later entries may.
            continue;
          }
          if (check(owner))
            chosen = { type: 'USER', id: owner, reason: 'Owner of the matching account' };
          break;
        }
        case 'ROUND_ROBIN': {
          const ids = [...pool.keys()];
          const after = lastUser;
          const start = after ? ids.findIndex((u) => u > after) : 0;
          for (let i = 0; i < ids.length; i += 1) {
            const u = ids[((start < 0 ? 0 : start) + i) % ids.length] ?? '';
            if (check(u)) {
              chosen = { type: 'USER', id: u, reason: 'Next in turn (round robin)' };
              break;
            }
          }
          break;
        }
        case 'WEIGHTED': {
          const eligible = [...pool.entries()].filter(([u]) => check(u));
          eligible.sort(
            ([a, wa], [b, wb]) =>
              (counts.get(a) ?? 0) / wa - (counts.get(b) ?? 0) / wb || a.localeCompare(b),
          );
          const best = eligible[0];
          if (best)
            chosen = {
              type: 'USER',
              id: best[0],
              reason: `Furthest below its share (weight ${String(best[1])})`,
            };
          break;
        }
        case 'LOAD_BALANCED':
        case 'SKILLS_BASED': {
          let required: string[] = [];
          if (entry.method === 'SKILLS_BASED') {
            required = [...(entry.settings.skills ?? [])];
            const field = entry.settings.skillField;
            const skillMeta = field ? object.fields.find((f) => f.apiName === field) : undefined;
            if (field && skillMeta) {
              const value = (
                await sql<{
                  v: string | null;
                }>`SELECT ${fieldExpr('r', skillMeta)}::text AS v
                  FROM ${table} AS r WHERE r.tenant_id = ${tenantId}::uuid AND r.id = ${recordId}::uuid`.execute(
                  tx.kysely,
                )
              ).rows[0]?.v;
              if (value) required.push(`${field}:${value.toLowerCase()}`);
            }
          }
          const eligible = [...pool.keys()].filter((u) => {
            const missing = required.filter((s) => !batch.users.get(u)?.skills.has(s));
            if (missing.length) {
              candidates.push({ userId: u, skipped: 'missing_skills' });
              return false;
            }
            return check(u);
          });
          eligible.sort(
            (a, b) =>
              (batch.openCount.get(a) ?? 0) - (batch.openCount.get(b) ?? 0) || a.localeCompare(b),
          );
          const best = eligible[0];
          if (best)
            chosen = {
              type: 'USER',
              id: best,
              reason:
                entry.method === 'SKILLS_BASED'
                  ? `Has the skills (${required.join(', ') || 'none required'}), fewest open records`
                  : 'Fewest open records',
            };
          break;
        }
      }
      if (!chosen && entry.settings.fallback)
        chosen = {
          type: entry.settings.fallback.type,
          id: entry.settings.fallback.id,
          reason: 'Nobody available: the entry’s fallback',
        };
      const previous = record?.owner_id ?? null;
      const outcome: AssignmentOutcome = chosen
        ? {
            recordId,
            ownerType: chosen.type,
            ownerId: chosen.id,
            previousOwnerId: previous,
            entryId: entry.id,
            method: entry.method,
            reason: chosen.reason,
            changed: chosen.id !== previous,
          }
        : {
            recordId,
            ownerType: 'USER',
            ownerId: previous ?? '',
            previousOwnerId: previous,
            entryId: entry.id,
            method: entry.method,
            reason: 'Nobody available and no fallback: owner kept',
            changed: false,
          };
      if (chosen?.type === 'USER') {
        batch.openCount.set(chosen.id, (batch.openCount.get(chosen.id) ?? 0) + 1);
        batch.newToday.set(chosen.id, (batch.newToday.get(chosen.id) ?? 0) + 1);
        counts.set(chosen.id, (counts.get(chosen.id) ?? 0) + 1);
        if (entry.method === 'ROUND_ROBIN') lastUser = chosen.id;
        turns += 1;
      }
      applied.push(recordId);
      outcomes.push(outcome);
      if (outcome.ownerId) logs.push({ recordId, entry, candidates, outcome });
    }
    await sql`UPDATE round_robin_cursor SET last_user_id = ${lastUser}::uuid,
        counts = ${JSON.stringify(Object.fromEntries(counts))}::jsonb, turns = ${turns}, updated_at = now()
      WHERE tenant_id = ${tenantId}::uuid AND entry_id = ${entry.id}::uuid`.execute(tx.kysely);
    remaining = remaining.filter((id) => !applied.includes(id));
  }

  await writeOwners(
    tx,
    env,
    object,
    outcomes.filter((o) => o.changed),
  );
  // The log is stamped with the real time (the injected clock only decides availability).
  const loggedAt = new Date();
  if (logs.length)
    await tx.prisma.assignmentLog.createMany({
      data: logs.map(({ recordId, entry, candidates, outcome }) => ({
        tenantId,
        assignedAt: loggedAt,
        object: objectName,
        recordId,
        ruleId: rule.id,
        entryId: entry?.id ?? null,
        method: outcome.method,
        ownerType: outcome.ownerType,
        ownerId: outcome.ownerId,
        previousOwnerId: outcome.previousOwnerId,
        candidates: candidates as never,
        reason: outcome.reason,
        source: options.source,
        actorId: env.actorId,
      })),
    });
  return outcomes;
}

/** Set the new owners set-based, with what an owner change brings (§3.7 steps 6–8). */
async function writeOwners(
  tx: TenantTransaction,
  env: AssignmentEnv,
  object: ObjectMeta,
  changes: readonly AssignmentOutcome[],
): Promise<void> {
  if (changes.length === 0) return;
  const tenantId = tx.context.tenantId;
  const values = sql.join(changes.map((c) => sql`(${c.recordId}::uuid, ${c.ownerId}::uuid)`));
  await sql`UPDATE ${sql.table(ident(object.table))} AS r
    SET owner_id = v.owner_id, version = r.version + 1, updated_at = now(),
      updated_by = coalesce(${env.actorId}::uuid, r.updated_by)
    FROM (VALUES ${values}) AS v (id, owner_id)
    WHERE r.tenant_id = ${tenantId}::uuid AND r.id = v.id`.execute(tx.kysely);
  const ids = changes.map((c) => c.recordId);
  // SLA clocks start (or follow the record to its new owner), and new owners hear about it.
  await startSlaTimers(tx, env.metadata, object, changes, env.now?.() ?? new Date());
  await notify(
    tx,
    changes
      .filter((c) => c.ownerType === 'USER' && c.ownerId !== env.actorId)
      .map((c) => ({
        userId: c.ownerId,
        kind: 'assignment',
        params: { method: c.method, reason: c.reason },
        object: object.apiName,
        recordId: c.recordId,
      })),
  );
  const ownerField = object.fields.find((f) => f.apiName === 'owner_id');
  if (ownerField?.trackHistory)
    await tx.prisma.fieldHistory.createMany({
      data: changes.map((c) => ({
        tenantId,
        object: object.apiName,
        recordId: c.recordId,
        field: 'owner_id',
        oldValue: c.previousOwnerId as never,
        newValue: c.ownerId as never,
        changedBy: env.actorId,
        requestId: env.requestId ?? null,
      })),
    });
  if (object.apiName === 'account')
    await syncAccountShares(tx, [...ids].sort(), { children: true });
  if (object.apiName === 'opportunity') await syncOpportunityShares(tx, ids);
  if (object.apiName === 'contact' || object.apiName === 'opportunity') {
    const accounts = await sql<{ account_id: string | null }>`
      SELECT DISTINCT account_id FROM ${sql.table(ident(object.table))}
      WHERE tenant_id = ${tenantId}::uuid AND id = ANY (${sql.val(ids)}::uuid[])`.execute(
      tx.kysely,
    );
    await syncAccountShares(tx, accounts.rows.map((r) => r.account_id).sort());
  }
  const rules = await activeRules(tx, object.apiName);
  if (rules.length)
    await evaluateRulesForRecords(tx.kysely, {
      tenantId,
      recordTable: object.table,
      recordIds: ids,
      rules,
    });
  await audit.recordMany(
    tx,
    changes.map((c) => ({
      action: 'record.assigned',
      object: object.apiName,
      recordId: c.recordId,
      payload: { fields: ['owner_id'], ownerType: c.ownerType, method: c.method },
      ...(env.actorId ? {} : { actorType: 'system' as const }),
      ...(env.requestId ? { requestId: env.requestId } : {}),
    })),
  );
  await outbox.emit(
    tx,
    changes.map((c) => ({
      topic: 'automation.owner_changed',
      aggregateType: object.apiName,
      aggregateId: c.recordId,
      payload: { object: object.apiName, id: c.recordId, changedFields: ['owner_id'] },
    })),
  );
}

/** Check an entry's criteria and formula compile (Setup); null when fine. */
export function entryCriteriaError(
  metadata: MetadataIndex,
  objectName: string,
  entry: { criteria?: unknown; formula?: string | null },
): string | null {
  const object = metadata.object(objectName);
  if (!object) return 'unknown_object';
  if (entry.formula) {
    const checked = checkFormula(
      entry.formula,
      metadataEnvironment(metadata, objectName, { allowPriorValues: false }),
      'Boolean',
    );
    if (!checked.ok) return 'invalid_formula';
  }
  return criteriaSql(
    object,
    { metadata, actorId: null, timezone: 'UTC' },
    {
      criteria: entry.criteria ?? null,
      formula: entry.formula ?? null,
    },
  )
    ? null
    : 'invalid_criteria';
}

/**
 * Queue pick-up (§7.3): a queue member takes a record the queue owns. With `recordId` it is
 * Accept (409 when the queue no longer owns it); without, Take next: the queue's best record
 * that no one else is taking at this moment (`FOR UPDATE SKIP LOCKED`), highest score first,
 * then oldest. Returns the record taken, or null when the queue is empty.
 */
export async function takeFromQueue(
  tx: TenantTransaction,
  env: AssignmentEnv & { actorId: string },
  objectName: string,
  queueId: string,
  options: { recordId?: string; source: 'accept' | 'take_next' },
): Promise<string | null> {
  const object = env.metadata.object(objectName);
  if (!object) return null;
  const tenantId = tx.context.tenantId;
  const order = object.fields.some((f) => f.apiName === 'score')
    ? sql`r.score DESC NULLS LAST, r.created_at, r.id`
    : sql`r.created_at, r.id`;
  const rows = await sql<{ id: string }>`
    SELECT r.id FROM ${sql.table(ident(object.table))} AS r
    WHERE r.tenant_id = ${tenantId}::uuid AND r.owner_id = ${queueId}::uuid AND r.deleted_at IS NULL
      ${options.recordId ? sql`AND r.id = ${options.recordId}::uuid` : sql``}
    ORDER BY ${order}
    LIMIT 1
    FOR UPDATE OF r SKIP LOCKED`.execute(tx.kysely);
  const id = rows.rows[0]?.id;
  if (!id) return null;
  const outcome: AssignmentOutcome = {
    recordId: id,
    ownerType: 'USER',
    ownerId: env.actorId,
    previousOwnerId: queueId,
    entryId: null,
    method: null,
    reason: options.source === 'accept' ? 'Accepted from the queue' : 'Taken next from the queue',
    changed: true,
  };
  await writeOwners(tx, env, object, [outcome]);
  await tx.prisma.assignmentLog.create({
    data: {
      tenantId,
      object: objectName,
      recordId: id,
      ownerType: 'USER',
      ownerId: env.actorId,
      previousOwnerId: queueId,
      candidates: [],
      reason: outcome.reason,
      source: options.source,
      actorId: env.actorId,
    },
  });
  return id;
}
