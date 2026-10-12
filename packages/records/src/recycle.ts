import { audit, outbox, type TenantTransaction } from '@sm/db';
import { fieldExpr, filterSqlWith, type FilterNode } from '@sm/query-engine';
import { sql } from 'kysely';

import { assignRecords, type AssignmentEnv } from './assignment.js';

/** Recycle leads every night (§7.3), per tenant, on the maintenance queue. */
export const LEAD_RECYCLE_TOPIC = 'maintenance.lead_recycle';
export const RECYCLE_CATEGORIES = ['UNQUALIFIED', 'NURTURE'] as const;

/**
 * Lead recycling (§7.3, P03 T15): leads left in an Unqualified or Nurture status, untouched for
 * the rule's number of days (no change of any kind, `updated_at`), and matching its criteria,
 * return to an open status and are routed again by the rule's assignment rule (or the default).
 * Set-based, a batch of leads at a time claimed with SKIP LOCKED; each recycled lead is
 * versioned, audited (`record.recycled`), announced and logged by the assignment it gets.
 * Validation rules are not run: recycling is the platform acting on stale data, not an edit.
 */
export async function recycleLeads(
  tx: TenantTransaction,
  env: AssignmentEnv,
  ruleId: string,
  options: { batch?: number } = {},
): Promise<number> {
  const lead = env.metadata.object('lead');
  const rule = await tx.prisma.recycleRule.findFirst({ where: { id: ruleId, active: true } });
  if (!lead || !rule) return 0;
  const statuses = lead.fields.find((f) => f.apiName === 'status')?.picklistValues ?? [];
  const from = statuses
    .filter((v) => v.category && rule.fromCategories.includes(v.category))
    .map((v) => v.apiValue);
  if (from.length === 0) return 0;
  let criteria = sql`TRUE`;
  if (rule.criteria) {
    try {
      criteria = sql`${filterSqlWith((name) => {
        const f = lead.fields.find((x) => x.apiName === name);
        if (!f) throw new Error(`unknown field ${name}`);
        return fieldExpr('r', f);
      }, rule.criteria as FilterNode)}`;
    } catch {
      return 0; // Criteria that no longer compile recycle nothing.
    }
  }
  const now = env.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - rule.afterDays * 86_400_000);
  const tenantId = tx.context.tenantId;
  const rows = await sql<{ id: string; status: string }>`
    SELECT r.id, r.status FROM lead AS r
    WHERE r.tenant_id = ${tenantId}::uuid AND r.deleted_at IS NULL AND r.converted_at IS NULL
      AND r.status = ANY (${sql.val(from)}::text[]) AND r.updated_at <= ${cutoff.toISOString()}::timestamptz
      AND ${criteria}
    ORDER BY r.updated_at, r.id
    LIMIT ${options.batch ?? 500}
    FOR UPDATE OF r SKIP LOCKED`.execute(tx.kysely);
  if (rows.rows.length === 0) return 0;
  const ids = rows.rows.map((r) => r.id);
  await sql`UPDATE lead SET status = ${rule.targetStatus}, unqualified_reason = NULL,
      version = version + 1, updated_at = now(), updated_by = coalesce(${env.actorId}::uuid, updated_by)
    WHERE tenant_id = ${tenantId}::uuid AND id = ANY (${sql.val(ids)}::uuid[])`.execute(tx.kysely);
  if (lead.fields.find((f) => f.apiName === 'status')?.trackHistory)
    await tx.prisma.fieldHistory.createMany({
      data: rows.rows.map((r) => ({
        tenantId,
        object: 'lead',
        recordId: r.id,
        field: 'status',
        oldValue: r.status as never,
        newValue: rule.targetStatus as never,
        changedBy: env.actorId,
        requestId: env.requestId ?? null,
      })),
    });
  await audit.recordMany(
    tx,
    ids.map((id) => ({
      action: 'record.recycled',
      object: 'lead',
      recordId: id,
      payload: { fields: ['status', 'unqualified_reason'], recycleRuleId: rule.id },
      actorType: 'system' as const,
    })),
  );
  await outbox.emit(
    tx,
    ids.map((id) => ({
      topic: 'automation.record_updated',
      aggregateType: 'lead',
      aggregateId: id,
      payload: { object: 'lead', id, changedFields: ['status', 'unqualified_reason'] },
    })),
  );
  await assignRecords(tx, env, 'lead', ids, { source: 'recycle', ruleId: rule.assignmentRuleId });
  return ids.length;
}
