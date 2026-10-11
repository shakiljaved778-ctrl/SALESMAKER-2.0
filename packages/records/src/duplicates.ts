import type { TenantTransaction } from '@sm/db';
import type { FieldMeta, ObjectMeta } from '@sm/metadata';
import { sharingPredicate } from '@sm/query-engine';
import { sql, type RawBuilder } from 'kysely';

import type { RecordContext } from './context.js';
import { RecordError, type FieldError } from './errors.js';
import { ident } from './storage.js';

/*
 * Duplicate management (§7.2, P03 T06). A matching rule is a list of conditions that must all hold
 * between a record being written (the probe) and a stored record (the candidate). Candidates are
 * found by equality on match keys (columns kept by trigger, migration 0022, with btree indexes
 * that work under row-level security); similarity and exact comparisons then refine them. The
 * same SQL compares a batch's rows with each other, computing the keys on the fly.
 */

export const MATCH_METHODS = [
  'exact',
  'fuzzy',
  'phone',
  'email',
  'email_domain_name',
  'company',
] as const;
export type MatchMethod = (typeof MATCH_METHODS)[number];

export interface MatchCondition {
  field: string;
  method: MatchMethod;
  /** Fuzzy only: the pg_trgm similarity a pair must reach (default 0.8). */
  threshold?: number;
}

export interface MatchingRuleDefinition {
  id: string;
  name: string;
  object: string;
  conditions: readonly MatchCondition[];
  matchBlank: boolean;
}

export const DEFAULT_FUZZY_THRESHOLD = 0.8;
export const DUPLICATE_OBJECTS = ['lead', 'contact', 'account'] as const;
/** Matches reported per record and rule. */
const MAX_MATCHES = 10;

type KeyName = 'email' | 'email_domain' | 'phone' | 'mobile' | 'name' | 'company' | 'domain';
const KEY_FUNCTION: Record<KeyName, string> = {
  email: 'crm_email_key',
  email_domain: 'crm_email_domain',
  phone: 'crm_phone_key',
  mobile: 'crm_phone_key',
  name: 'crm_name_key',
  company: 'crm_company_key',
  domain: 'crm_domain_key',
};
/** The key column each keyed field feeds, per object (migration 0022). */
const FIELD_KEYS: Record<string, Record<string, KeyName>> = {
  lead: {
    email: 'email',
    phone: 'phone',
    mobile_phone: 'mobile',
    last_name: 'name',
    company: 'company',
  },
  contact: { email: 'email', phone: 'phone', mobile_phone: 'mobile', last_name: 'name' },
  account: { name: 'company', phone: 'phone', website: 'domain' },
};
const KEY_COLUMN: Record<KeyName, string> = {
  email: 'match_email',
  email_domain: 'match_email_domain',
  phone: 'match_phone',
  mobile: 'match_mobile',
  name: 'match_name_key',
  company: 'match_company_key',
  domain: 'match_domain',
};
/** The field each key is computed from (the inverse of FIELD_KEYS, plus the email domain). */
const KEY_SOURCE: Record<string, Partial<Record<KeyName, string>>> = {
  lead: {
    email: 'email',
    email_domain: 'email',
    phone: 'phone',
    mobile: 'mobile_phone',
    name: 'last_name',
    company: 'company',
  },
  contact: {
    email: 'email',
    email_domain: 'email',
    phone: 'phone',
    mobile: 'mobile_phone',
    name: 'last_name',
  },
  account: { company: 'name', phone: 'phone', domain: 'website' },
};
const PHONE_KEYS: Record<string, KeyName[]> = {
  lead: ['phone', 'mobile'],
  contact: ['phone', 'mobile'],
  account: ['phone'],
};

/** One side of a comparison: a stored row (keys are indexed columns) or a batch row. */
interface Side {
  raw(field: FieldMeta): RawBuilder<unknown>;
  key(name: KeyName): RawBuilder<unknown>;
}

function storedSide(alias: string): Side {
  return {
    raw: (f) =>
      f.storage.kind === 'column'
        ? sql`(${sql.ref(`${alias}.${ident(f.storage.column)}`)})::text`
        : sql`(${sql.ref(`${alias}.custom`)} ->> ${f.storage.key})`,
    key: (name) => sql.ref(`${alias}.${KEY_COLUMN[name]}`),
  };
}

/** A batch row in a VALUES list: one text column per field the rule reads, named f_<field>. */
function batchSide(alias: string, object: ObjectMeta): Side {
  const raw = (name: string) => sql.ref(`${alias}.f_${ident(name)}`);
  return {
    raw: (f) => raw(f.apiName),
    key: (name) => {
      const source = KEY_SOURCE[object.apiName]?.[name];
      return source ? sql`${sql.raw(KEY_FUNCTION[name])}(${raw(source)})` : sql`NULL::text`;
    },
  };
}

const blank = (e: RawBuilder<unknown>) => sql`nullif(btrim(${e}), '') IS NULL`;

/** Problems with a rule's conditions on `object`; empty when it can run. */
export function conditionErrors(
  object: ObjectMeta,
  conditions: readonly MatchCondition[],
): FieldError[] {
  const errors: FieldError[] = [];
  const keys = FIELD_KEYS[object.apiName] ?? {};
  if (conditions.length === 0) errors.push({ field: 'conditions', code: 'required' });
  let keyed = false;
  for (const [i, c] of conditions.entries()) {
    const at = `conditions.${String(i)}`;
    const f = object.fields.find((x) => x.apiName === c.field);
    if (!f) {
      errors.push({ field: `${at}.field`, code: 'unknown_field' });
      continue;
    }
    const fits: Record<MatchMethod, boolean> = {
      exact: true,
      fuzzy: !['checkbox', 'lookup', 'master_detail', 'user', 'multi_picklist'].includes(f.type),
      email: f.type === 'email',
      phone: f.type === 'phone',
      company: keys[c.field] === 'company',
      email_domain_name: object.apiName !== 'account',
    };
    const ok = fits[c.method];
    if (!ok) errors.push({ field: `${at}.method`, code: 'not_for_field' });
    if (c.method === 'email_domain_name' || keys[c.field]) keyed = true;
  }
  // Without a keyed condition, finding candidates would scan the whole object.
  if (conditions.length && !keyed)
    errors.push({ field: 'conditions', code: 'needs_keyed_condition' });
  return errors;
}

/** One condition as SQL between probe `p` and candidate `c`, with its score (0–1). */
function conditionSql(
  object: ObjectMeta,
  rule: MatchingRuleDefinition,
  c: MatchCondition,
  p: Side,
  q: Side,
): { match: RawBuilder<unknown>; score: RawBuilder<unknown> } | null {
  const f = object.fields.find((x) => x.apiName === c.field);
  if (!f) return null;
  const keyName = FIELD_KEYS[object.apiName]?.[c.field];
  const pRaw = p.raw(f);
  const qRaw = q.raw(f);
  // Equality of the field's key, implied by every method on a keyed field: it drives the index.
  const sameKey = keyName ? sql`${p.key(keyName)} = ${q.key(keyName)}` : sql`TRUE`;
  let match: RawBuilder<unknown>;
  let score: RawBuilder<unknown> = sql`1.0`;
  switch (c.method) {
    case 'email':
      match = keyName === 'email' ? sameKey : sql`crm_email_key(${pRaw}) = crm_email_key(${qRaw})`;
      break;
    case 'company':
      match = sameKey;
      break;
    case 'phone': {
      const probe = keyName ? p.key(keyName) : sql`crm_phone_key(${pRaw})`;
      const columns = (PHONE_KEYS[object.apiName] ?? []).map((k) => sql`${probe} = ${q.key(k)}`);
      match = sql`(${sql.join(columns, sql` OR `)})`;
      break;
    }
    case 'email_domain_name':
      match = sql`${p.key('email_domain')} = ${q.key('email_domain')} AND ${p.key('name')} = ${q.key('name')}`;
      break;
    case 'exact':
      match = sql`${sameKey} AND lower(btrim(${pRaw})) = lower(btrim(${qRaw}))`;
      break;
    case 'fuzzy': {
      const threshold = c.threshold ?? DEFAULT_FUZZY_THRESHOLD;
      score = sql`similarity(lower(${pRaw}), lower(${qRaw}))::numeric`;
      match = sql`${sameKey} AND similarity(lower(${pRaw}), lower(${qRaw})) >= ${threshold}::real`;
      break;
    }
  }
  const both = rule.matchBlank
    ? sql`((${blank(pRaw)} AND ${blank(qRaw)}) OR (NOT ${blank(pRaw)} AND ${match}))`
    : sql`(NOT ${blank(pRaw)} AND ${match})`;
  const scored = rule.matchBlank
    ? sql`(CASE WHEN ${blank(pRaw)} THEN 1.0 ELSE ${score} END)`
    : score;
  return { match: both, score: scored };
}

export interface Probe {
  /** Position in the caller's list. */
  index: number;
  /** The record's own id on edit, so it never matches itself. */
  id: string | null;
  values: Record<string, unknown>;
}

export interface DuplicateMatch {
  /** A stored record, or (within a batch) an earlier row of the batch. */
  id: string | null;
  batchIndex?: number;
  score: number;
  /** Whether the writer can see the stored record (sharing). */
  visible: boolean;
}

function readFields(object: ObjectMeta, rule: MatchingRuleDefinition): FieldMeta[] {
  const names = new Set(rule.conditions.map((c) => c.field));
  const sources = KEY_SOURCE[object.apiName] ?? {};
  // Fields the batch side derives keys from.
  for (const c of rule.conditions) {
    const k = FIELD_KEYS[object.apiName]?.[c.field];
    if (k) names.add(sources[k] ?? c.field);
    if (c.method === 'email_domain_name') {
      names.add(sources.email ?? 'email');
      names.add(sources.name ?? 'last_name');
    }
  }
  return object.fields.filter((f) => names.has(f.apiName));
}

/** The probes as a VALUES list `b(idx, self_id, f_<field>…)`, every value as text. */
/** A stored value as the text the comparisons read. */
function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(asText).join(';');
  return JSON.stringify(v);
}

function probeValues(probes: readonly Probe[], fields: readonly FieldMeta[]) {
  const text = (v: unknown) =>
    v === null || v === undefined ? sql`NULL::text` : sql`${asText(v)}::text`;
  return sql.join(
    probes.map(
      (p) =>
        sql`(${sql.join([
          sql`${p.index}::int`,
          p.id ? sql`${p.id}::uuid` : sql`NULL::uuid`,
          ...fields.map((f) => text(p.values[f.apiName])),
        ])})`,
    ),
  );
}

const columnList = (fields: readonly FieldMeta[]) =>
  sql.join([
    sql.raw('idx'),
    sql.raw('self_id'),
    ...fields.map((f) => sql.raw(`f_${ident(f.apiName)}`)),
  ]);

/**
 * Stored records matching each probe under `rule`: one statement for all probes, candidates
 * found through the match-key indexes. Live, unmerged records only; at most ten per probe, best
 * first. `visible` says whether the writer can read each one.
 */
export async function findMatches(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: ObjectMeta,
  rule: MatchingRuleDefinition,
  probes: readonly Probe[],
): Promise<Map<number, DuplicateMatch[]>> {
  const out = new Map<number, DuplicateMatch[]>();
  if (probes.length === 0) return out;
  const fields = readFields(object, rule);
  const parts = rule.conditions
    .map((c) => conditionSql(object, rule, c, batchSide('b', object), storedSide('r')))
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (parts.length === 0) return out;
  const score = sql`((${sql.join(
    parts.map((p) => p.score),
    sql` + `,
  )}) / ${parts.length}::numeric)`;
  const rows = await sql<{ idx: number; id: string; score: string; visible: boolean }>`
    WITH b (${columnList(fields)}) AS (VALUES ${probeValues(probes, fields)}),
    m AS (
      SELECT b.idx, r.id, ${score} AS score,
        (${sharingPredicate(ctx.sharing, object.apiName, 'r', 'read')}) AS visible
      FROM b JOIN ${sql.table(ident(object.table))} AS r
        ON r.tenant_id = ${tx.context.tenantId}::uuid AND r.deleted_at IS NULL
       AND r.merged_into_id IS NULL AND r.id IS DISTINCT FROM b.self_id
       AND ${sql.join(
         parts.map((p) => p.match),
         sql` AND `,
       )}
    )
    SELECT idx, id::text AS id, round(score, 4)::text AS score, visible FROM (
      SELECT m.*, row_number() OVER (PARTITION BY idx ORDER BY score DESC, id) AS rn FROM m
    ) ranked WHERE rn <= ${MAX_MATCHES} ORDER BY idx, score DESC, id`.execute(tx.kysely);
  for (const r of rows.rows) {
    const list = out.get(r.idx) ?? [];
    list.push({ id: r.id, score: Number(r.score), visible: r.visible });
    out.set(r.idx, list);
  }
  return out;
}

/**
 * Pairs within a batch that match under `rule`: for each probe, the earlier probes it matches
 * (the first of a group is the original).
 */
export async function findBatchMatches(
  tx: TenantTransaction,
  object: ObjectMeta,
  rule: MatchingRuleDefinition,
  probes: readonly Probe[],
): Promise<Map<number, DuplicateMatch[]>> {
  const out = new Map<number, DuplicateMatch[]>();
  if (probes.length < 2) return out;
  const fields = readFields(object, rule);
  const parts = rule.conditions
    .map((c) => conditionSql(object, rule, c, batchSide('b', object), batchSide('e', object)))
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (parts.length === 0) return out;
  const score = sql`((${sql.join(
    parts.map((p) => p.score),
    sql` + `,
  )}) / ${parts.length}::numeric)`;
  const rows = await sql<{ idx: number; earlier: number; score: string }>`
    WITH b (${columnList(fields)}) AS (VALUES ${probeValues(probes, fields)})
    SELECT b.idx, e.idx AS earlier, round(${score}, 4)::text AS score
    FROM b JOIN b AS e ON e.idx < b.idx AND ${sql.join(
      parts.map((p) => p.match),
      sql` AND `,
    )}
    ORDER BY b.idx, e.idx`.execute(tx.kysely);
  for (const r of rows.rows) {
    const list = out.get(r.idx) ?? [];
    list.push({ id: null, batchIndex: r.earlier, score: Number(r.score), visible: true });
    out.set(r.idx, list);
  }
  return out;
}

export interface DuplicateRuleDefinition {
  id: string;
  name: string;
  action: 'BLOCK' | 'ALERT';
  onCreate: boolean;
  onEdit: boolean;
  bypassProfileIds: readonly string[];
  matchingRule: MatchingRuleDefinition;
}

/** What a write learnt from the Alert rules: the visible matches, per rule. */
export interface DuplicateAlert {
  ruleId: string;
  rule: string;
  matches: { id: string | null; batchIndex?: number; score: number }[];
}

const RULES = new WeakMap<RecordContext, Map<string, Promise<DuplicateRuleDefinition[]>>>();
const PROFILE = new WeakMap<RecordContext, Promise<string | null>>();

/** The object's active duplicate rules with active matching rules, read once per context. */
export function duplicateRules(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: string,
): Promise<DuplicateRuleDefinition[]> {
  if (!(DUPLICATE_OBJECTS as readonly string[]).includes(object)) return Promise.resolve([]);
  let byObject = RULES.get(ctx);
  if (!byObject) {
    byObject = new Map();
    RULES.set(ctx, byObject);
  }
  let rules = byObject.get(object);
  if (!rules) {
    rules = tx.prisma.duplicateRule
      .findMany({
        where: { object, active: true, matchingRule: { active: true } },
        include: { matchingRule: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      })
      .then((rows) =>
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          action: r.action,
          onCreate: r.onCreate,
          onEdit: r.onEdit,
          bypassProfileIds: r.bypassProfileIds,
          matchingRule: {
            id: r.matchingRule.id,
            name: r.matchingRule.name,
            object: r.matchingRule.object,
            conditions: r.matchingRule.conditions as unknown as MatchCondition[],
            matchBlank: r.matchingRule.matchBlank,
          },
        })),
      );
    byObject.set(object, rules);
  }
  return rules;
}

function profileOf(tx: TenantTransaction, ctx: RecordContext): Promise<string | null> {
  let found = PROFILE.get(ctx);
  if (!found) {
    found = tx.prisma.user
      .findUnique({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id: ctx.userId } },
        select: { profileId: true },
      })
      .then((u) => u?.profileId ?? null);
    PROFILE.set(ctx, found);
  }
  return found;
}

const blocked = (rule: DuplicateRuleDefinition, matches: readonly DuplicateMatch[]) =>
  new RecordError(
    'conflict',
    [{ field: '_record', code: 'duplicate_blocked', message: rule.name }],
    {
      rule: rule.name,
      // Only what the writer may see; a Block applies to records they cannot see too.
      matches: matches.filter((m) => m.visible).map((m) => m.id ?? `#${String(m.batchIndex)}`),
    },
  );

const alertOf = (
  rule: DuplicateRuleDefinition,
  matches: readonly DuplicateMatch[],
): DuplicateAlert | null => {
  const shown = matches.filter((m) => m.visible);
  return shown.length
    ? {
        ruleId: rule.id,
        rule: rule.name,
        matches: shown.map((m) => ({
          id: m.id,
          ...(m.batchIndex === undefined ? {} : { batchIndex: m.batchIndex }),
          score: m.score,
        })),
      }
    : null;
};

/** The rules that apply to this write: create or edit, and (on edit) a compared field changed. */
async function applicable(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: ObjectMeta,
  isNew: boolean,
  changed: ReadonlySet<string> | null,
): Promise<DuplicateRuleDefinition[]> {
  const rules = (await duplicateRules(tx, ctx, object.apiName)).filter((r) =>
    isNew ? r.onCreate : r.onEdit,
  );
  return changed
    ? rules.filter((r) => r.matchingRule.conditions.some((c) => changed.has(c.field)))
    : rules;
}

/**
 * Run the duplicate rules on one write (§3.7 step 5, before validation rules): throws on a Block
 * rule's match unless the writer's profile bypasses it; returns the Alert rules' visible matches.
 */
export async function checkDuplicates(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: ObjectMeta,
  values: Record<string, unknown>,
  current: { id: string; changed: ReadonlySet<string> } | null,
): Promise<DuplicateAlert[]> {
  const rules = await applicable(tx, ctx, object, current === null, current?.changed ?? null);
  const alerts: DuplicateAlert[] = [];
  for (const rule of rules) {
    const matches =
      (
        await findMatches(tx, ctx, object, rule.matchingRule, [
          { index: 0, id: current?.id ?? null, values },
        ])
      ).get(0) ?? [];
    if (matches.length === 0) continue;
    if (rule.action === 'BLOCK') {
      const profile = rule.bypassProfileIds.length ? await profileOf(tx, ctx) : null;
      if (!profile || !rule.bypassProfileIds.includes(profile)) throw blocked(rule, matches);
    }
    const alert = alertOf(rule, matches);
    if (alert) alerts.push(alert);
  }
  return alerts;
}

/**
 * The same for a batch of new records (bulk.ts): stored matches for all rows in one statement per
 * rule, then matches between the rows themselves. Returns, per row index, the Block error or
 * the alerts. `stored` runs before validation rules, as on the single path; `withinBatch` after,
 * over the rows still accepted, so a row only counts as a duplicate of rows that will be saved.
 */
export function batchDuplicates(tx: TenantTransaction, ctx: RecordContext, object: ObjectMeta) {
  const errors = new Map<number, RecordError>();
  const alerts = new Map<number, DuplicateAlert[]>();
  const note = (index: number, alert: DuplicateAlert | null) => {
    if (alert) alerts.set(index, [...(alerts.get(index) ?? []), alert]);
  };
  const bypassed = async (rule: DuplicateRuleDefinition) => {
    if (rule.bypassProfileIds.length === 0) return false;
    const profile = await profileOf(tx, ctx);
    return profile !== null && rule.bypassProfileIds.includes(profile);
  };
  return {
    errors,
    alerts,
    async stored(probes: readonly Probe[]) {
      for (const rule of await applicable(tx, ctx, object, true, null)) {
        const found = await findMatches(
          tx,
          ctx,
          object,
          rule.matchingRule,
          probes.filter((p) => !errors.has(p.index)),
        );
        for (const [index, matches] of found) {
          if (rule.action === 'BLOCK' && !(await bypassed(rule)))
            errors.set(index, blocked(rule, matches));
          else note(index, alertOf(rule, matches));
        }
      }
    },
    async withinBatch(probes: readonly Probe[]) {
      for (const rule of await applicable(tx, ctx, object, true, null)) {
        const live = probes.filter((p) => !errors.has(p.index));
        const found = await findBatchMatches(tx, object, rule.matchingRule, live);
        const block = rule.action === 'BLOCK' && !(await bypassed(rule));
        for (const p of live) {
          // Only earlier rows that are still being saved count.
          const matches = (found.get(p.index) ?? []).filter(
            (m) => m.batchIndex !== undefined && !errors.has(m.batchIndex),
          );
          if (matches.length === 0) continue;
          if (block) errors.set(p.index, blocked(rule, matches));
          else note(p.index, alertOf(rule, matches));
        }
      }
    },
  };
}
