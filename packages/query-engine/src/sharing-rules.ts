import { sql, type Expression, type Kysely, type SqlBool } from 'kysely';

import { filterSql, parseFilter } from './filter.js';

/**
 * Row types for dynamic, metadata-driven SQL (same shape as @sm/db DynamicDatabase). Writes use
 * RETURNING to count rows: inside a tenant transaction raw statements run through Prisma's raw
 * query API, which reports rows, not affected counts.
 */
export type Db = Kysely<Record<string, Record<string, unknown>>>;

export type SharePrincipalType =
  'USER' | 'GROUP' | 'QUEUE' | 'ORG_UNIT' | 'ORG_UNIT_AND_SUBORDINATES';

export interface PrincipalRef {
  type: SharePrincipalType;
  id: string;
}

/** `source_id` of shares nobody else created (manual shares). */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export interface SharingRuleDefinition {
  id: string;
  object: string;
  kind: 'OWNER' | 'CRITERIA';
  sourceType: SharePrincipalType | null;
  sourceId: string | null;
  criteria: unknown;
  targetType: SharePrincipalType;
  targetId: string;
  /** 1 Read, 2 Read-Write. */
  access: number;
  active: boolean;
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
function table(name: string) {
  if (!IDENT.test(name)) throw new Error(`invalid table ${name}`);
  return sql.table(name);
}

/** Users a principal stands for (current tenant; RLS applies). */
function usersOf(tenantId: string, type: SharePrincipalType, id: string) {
  switch (type) {
    case 'USER':
      return sql`SELECT ${id}::uuid`;
    case 'GROUP':
      return sql`SELECT group_user_ids(${id}::uuid)`;
    case 'QUEUE':
      return sql`SELECT queue_user_ids(${id}::uuid)`;
    case 'ORG_UNIT':
      return sql`SELECT u.id FROM "user" u WHERE u.tenant_id = ${tenantId}::uuid AND u.org_unit_id = ${id}::uuid`;
    case 'ORG_UNIT_AND_SUBORDINATES':
      return sql`SELECT u.id FROM org_unit_closure c
        JOIN "user" u ON u.tenant_id = c.tenant_id AND u.org_unit_id = c.descendant_id
        WHERE c.tenant_id = ${tenantId}::uuid AND c.ancestor_id = ${id}::uuid`;
  }
}

/** Which records of the rule's object it shares, over rows aliased `r`. */
export function ruleMatches(tenantId: string, rule: SharingRuleDefinition): Expression<SqlBool> {
  if (rule.kind === 'OWNER') {
    if (!rule.sourceType || !rule.sourceId) throw new Error(`owner rule ${rule.id} has no source`);
    return sql<SqlBool>`r.owner_id IN (${usersOf(tenantId, rule.sourceType, rule.sourceId)})`;
  }
  const filter = parseFilter(rule.criteria);
  return filterSql('r', filter);
}

/** Grant (or change) a manual share (§6.3): the owner or a user with Full access shares a record. */
export async function grantManualShare(
  db: Db,
  input: {
    tenantId: string;
    object: string;
    recordId: string;
    principal: PrincipalRef;
    access: 1 | 2;
    createdBy?: string;
  },
): Promise<void> {
  await sql`
    INSERT INTO record_share (tenant_id, object, record_id, principal_type, principal_id, access, reason, source_id, created_by)
    VALUES (${input.tenantId}::uuid, ${input.object}, ${input.recordId}::uuid,
      ${input.principal.type}::share_principal_type, ${input.principal.id}::uuid, ${input.access},
      'MANUAL', ${NIL_UUID}::uuid, ${input.createdBy ?? null}::uuid)
    ON CONFLICT (tenant_id, object, record_id, principal_type, principal_id, reason, source_id)
    DO UPDATE SET access = EXCLUDED.access`.execute(db);
}

export async function revokeManualShare(
  db: Db,
  input: { tenantId: string; object: string; recordId: string; principal: PrincipalRef },
): Promise<boolean> {
  const result = await sql`
    DELETE FROM record_share
    WHERE tenant_id = ${input.tenantId}::uuid AND object = ${input.object}
      AND record_id = ${input.recordId}::uuid AND reason = 'MANUAL'
      AND principal_type = ${input.principal.type}::share_principal_type
      AND principal_id = ${input.principal.id}::uuid
    RETURNING id`.execute(db);
  return result.rows.length > 0;
}

/** Write the rule shares of the given records: remove the rule's old ones, add current matches. */
async function applyRule(
  db: Db,
  tenantId: string,
  rule: SharingRuleDefinition,
  recordTable: string,
  recordIds: readonly string[],
): Promise<number> {
  const ids = sql`${sql.val([...recordIds])}::uuid[]`;
  await sql`
    DELETE FROM record_share
    WHERE tenant_id = ${tenantId}::uuid AND object = ${rule.object} AND reason = 'RULE'
      AND source_id = ${rule.id}::uuid AND record_id = ANY (${ids})`.execute(db);
  if (!rule.active) return 0;
  const inserted = await sql`
    INSERT INTO record_share (tenant_id, object, record_id, principal_type, principal_id, access, reason, source_id)
    SELECT ${tenantId}::uuid, ${rule.object}, r.id, ${rule.targetType}::share_principal_type,
      ${rule.targetId}::uuid, ${rule.access}, 'RULE', ${rule.id}::uuid
    FROM ${table(recordTable)} AS r
    WHERE r.tenant_id = ${tenantId}::uuid AND r.id = ANY (${ids}) AND ${ruleMatches(tenantId, rule)}
    ON CONFLICT DO NOTHING
    RETURNING id`.execute(db);
  return inserted.rows.length;
}

/**
 * Re-evaluate every sharing rule of the record's object for one record, in the caller's
 * transaction (RecordService calls this on create and update, P02). Returns the shares written.
 */
export async function evaluateRulesForRecord(
  db: Db,
  input: {
    tenantId: string;
    recordTable: string;
    recordId: string;
    rules: readonly SharingRuleDefinition[];
  },
): Promise<number> {
  let written = 0;
  for (const rule of input.rules)
    written += await applyRule(db, input.tenantId, rule, input.recordTable, [input.recordId]);
  return written;
}

export interface RecalculationProgress {
  done: number;
  total: number;
  written: number;
}

/**
 * Recalculate one rule over all records of its object in batches (§6.4), each batch in its own
 * transaction via `inTransaction`, so a huge object never holds one long transaction and the
 * work resumes safely after a crash (every batch is idempotent). An inactive or deleted rule's
 * shares are removed. `onProgress` runs after each batch.
 */
export async function recalculateRule(
  inTransaction: <T>(fn: (db: Db) => Promise<T>) => Promise<T>,
  input: {
    tenantId: string;
    rule: SharingRuleDefinition;
    recordTable: string;
    batchSize?: number;
    onProgress?: (progress: RecalculationProgress) => Promise<void>;
  },
): Promise<RecalculationProgress> {
  const { tenantId, rule, recordTable, batchSize = 1000 } = input;
  const total = await inTransaction(async (db) => {
    const r = await sql<{ n: string }>`
      SELECT count(*) AS n FROM ${table(recordTable)} WHERE tenant_id = ${tenantId}::uuid`.execute(
      db,
    );
    return Number(r.rows[0]?.n ?? 0);
  });
  const progress: RecalculationProgress = { done: 0, total, written: 0 };
  let after: string | null = null;
  for (;;) {
    const cursor: string | null = after;
    const batch = await inTransaction(async (db): Promise<{ ids: string[]; written: number }> => {
      const r = await sql<{ id: string }>`
        SELECT id FROM ${table(recordTable)}
        WHERE tenant_id = ${tenantId}::uuid AND (${cursor}::uuid IS NULL OR id > ${cursor}::uuid)
        ORDER BY id LIMIT ${batchSize}`.execute(db);
      const ids = r.rows.map((row) => row.id);
      const written = ids.length ? await applyRule(db, tenantId, rule, recordTable, ids) : 0;
      return { ids, written };
    });
    if (batch.ids.length === 0) break;
    progress.done += batch.ids.length;
    progress.written += batch.written;
    after = batch.ids.at(-1) ?? null;
    await input.onProgress?.({ ...progress });
    if (batch.ids.length < batchSize) break;
  }
  // Shares for records deleted since (or when the rule no longer applies anywhere) are gone too.
  if (!rule.active)
    await inTransaction((db) =>
      sql`DELETE FROM record_share WHERE tenant_id = ${tenantId}::uuid AND object = ${rule.object}
        AND reason = 'RULE' AND source_id = ${rule.id}::uuid`.execute(db),
    );
  return progress;
}

/** Remove every share a (deleted) rule created. */
export async function removeRuleShares(
  db: Db,
  input: { tenantId: string; object: string; ruleId: string },
): Promise<number> {
  const result = await sql`
    DELETE FROM record_share WHERE tenant_id = ${input.tenantId}::uuid AND object = ${input.object}
      AND reason = 'RULE' AND source_id = ${input.ruleId}::uuid
    RETURNING id`.execute(db);
  return result.rows.length;
}
