import { audit, outbox, type TenantTransaction } from '@sm/db';
import type { FieldMeta, ObjectMeta } from '@sm/metadata';
import { fieldAccess, objectAccess } from '@sm/permissions';
import { evaluateRulesForRecords } from '@sm/query-engine';
import { sql } from 'kysely';

import type { RecordContext } from './context.js';
import { deleteRecord } from './delete.js';
import { DUPLICATE_OBJECTS } from './duplicates.js';
import { RecordError } from './errors.js';
import { activeRules, hasAccess, LOOKUPS, updateRecord } from './service.js';
import { syncAccountShares, syncOpportunityShares } from './shares.js';
import { ident, readStored } from './storage.js';

export interface MergeInput {
  /** The record that survives. */
  masterId: string;
  /** One or two records merged into it. */
  duplicateIds: readonly string[];
  /** Field → the record whose value the survivor keeps; fields left out keep the master's. */
  fields?: Readonly<Record<string, string>>;
  /** Optimistic lock on the master (If-Match). */
  version?: number | null;
}

export interface MergeResult {
  id: string;
  version: number;
  merged: string[];
  /** Child records and link rows moved to the survivor. */
  reparented: number;
}

/**
 * Link tables whose rows follow a merged record: table → [column pointing at the record, the
 * column that identifies the link]. A link the survivor already has is dropped, not duplicated.
 */
const LINKS: Record<string, readonly (readonly [string, string, string])[]> = {
  account: [
    ['account_contact_relation', 'account_id', 'contact_id'],
    ['account_team_member', 'account_id', 'user_id'],
  ],
  contact: [
    ['account_contact_relation', 'contact_id', 'account_id'],
    ['opportunity_contact_role', 'contact_id', 'opportunity_id'],
    ['campaign_member', 'contact_id', 'campaign_id'],
  ],
  lead: [['campaign_member', 'lead_id', 'campaign_id']],
};

const uuids = (ids: readonly string[]) => sql`${sql.val([...ids])}::uuid[]`;

/** Every lookup field, on any object, that can point at `target` (custom lookups included). */
function referencesTo(ctx: RecordContext, target: string): [ObjectMeta, FieldMeta][] {
  const out: [ObjectMeta, FieldMeta][] = [];
  for (const object of ctx.metadata.metadata.objects)
    for (const f of object.fields)
      if (LOOKUPS.has(f.type) && f.referenceTo.includes(target)) out.push([object, f]);
  return out;
}

/**
 * Point every child record at the survivor (§7.2): lookups on any object, live or in the bin, with
 * version, history for tracked fields, audit and events per child, then the shares that depend
 * on them. A record that would end up pointing at itself (the survivor's own parent was a
 * merged record) is cleared instead. RecordService-owned, set-based, as the writer.
 */
async function reparent(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: ObjectMeta,
  masterId: string,
  losers: readonly string[],
): Promise<number> {
  const tenantId = tx.context.tenantId;
  let moved = 0;
  for (const [child, field] of referencesTo(ctx, object.apiName)) {
    const target =
      field.storage.kind === 'column'
        ? sql.ref(ident(field.storage.column))
        : sql`(custom ->> ${field.storage.key})::uuid`;
    const assign =
      field.storage.kind === 'column'
        ? sql`${sql.ref(ident(field.storage.column))} = CASE WHEN id = ${masterId}::uuid THEN NULL ELSE ${masterId}::uuid END`
        : sql`custom = CASE WHEN id = ${masterId}::uuid THEN custom - ${field.storage.key}
            ELSE jsonb_set(custom, ${sql.val([field.storage.key])}::text[], to_jsonb(${masterId}::text)) END`;
    const rows = await sql<{ id: string }>`
      UPDATE ${sql.table(ident(child.table))}
      SET ${assign}, version = version + 1, updated_by = ${ctx.userId}::uuid, updated_at = now()
      WHERE tenant_id = ${tenantId}::uuid AND ${target} = ANY (${uuids(losers)})
      RETURNING id`.execute(tx.kysely);
    const ids = rows.rows.map((r) => r.id);
    if (ids.length === 0) continue;
    moved += ids.length;
    if (field.trackHistory)
      await tx.prisma.fieldHistory.createMany({
        data: ids.map((id) => ({
          tenantId,
          object: child.apiName,
          recordId: id,
          field: field.apiName,
          oldValue: null as never,
          newValue: (id === masterId ? null : masterId) as never,
          changedBy: ctx.userId,
          requestId: ctx.requestId ?? null,
        })),
      });
    await audit.recordMany(
      tx,
      ids.map((id) => ({
        action: 'record.updated',
        object: child.apiName,
        recordId: id,
        payload: { fields: [field.apiName], mergedInto: masterId },
        ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
      })),
    );
    await outbox.emit(
      tx,
      ids.map((id) => ({
        topic: 'automation.record_updated',
        aggregateType: child.apiName,
        aggregateId: id,
        payload: { object: child.apiName, id, changedFields: [field.apiName] },
      })),
    );
    if (child.apiName === 'opportunity') await syncOpportunityShares(tx, ids);
    const rules = await activeRules(tx, child.apiName);
    if (rules.length)
      await evaluateRulesForRecords(tx.kysely, {
        tenantId,
        recordTable: child.table,
        recordIds: ids,
        rules,
      });
  }
  for (const [table, column, other] of LINKS[object.apiName] ?? []) {
    // Keep one link per counterpart: the survivor's own, else the merged record's with the lowest id.
    await sql`
      DELETE FROM ${sql.table(table)} AS a USING ${sql.table(table)} AS b
      WHERE a.tenant_id = ${tenantId}::uuid AND b.tenant_id = a.tenant_id
        AND a.${sql.ref(column)} = ANY (${uuids(losers)})
        AND b.${sql.ref(column)} = ANY (${uuids([masterId, ...losers])})
        AND a.${sql.ref(other)} = b.${sql.ref(other)} AND a.id <> b.id
        AND (b.${sql.ref(column)} = ${masterId}::uuid OR (b.${sql.ref(column)} <> ${masterId}::uuid AND b.id < a.id))`.execute(
      tx.kysely,
    );
    const updated = await sql`
      UPDATE ${sql.table(table)} SET ${sql.ref(column)} = ${masterId}::uuid
      WHERE tenant_id = ${tenantId}::uuid AND ${sql.ref(column)} = ANY (${uuids(losers)})`.execute(
      tx.kysely,
    );
    moved += Number(updated.numAffectedRows ?? 0);
  }
  // Implicit shares follow the contacts and opportunities now under the surviving account.
  if (object.apiName === 'account') await syncAccountShares(tx, [masterId], { children: true });
  if (object.apiName === 'contact' || object.apiName === 'opportunity') {
    const accounts = await sql<{ account_id: string | null }>`
      SELECT DISTINCT account_id FROM ${sql.table(ident(object.table))}
      WHERE tenant_id = ${tenantId}::uuid AND id = ANY (${uuids([masterId, ...losers])})`.execute(
      tx.kysely,
    );
    await syncAccountShares(tx, accounts.rows.map((r) => r.account_id).sort());
  }
  return moved;
}

/**
 * Merge two or three records of a lead, contact or account (§7.2): the survivor takes the chosen
 * field values (through updateRecord, as the writer, without duplicate rules), children and links
 * move to it, and the others go to the recycle bin with `merged_into_id`. Needs Edit on the
 * survivor and Delete with Full access on the others; converted leads cannot be merged.
 */
export async function mergeRecords(
  tx: TenantTransaction,
  ctx: RecordContext,
  objectName: string,
  input: MergeInput,
): Promise<MergeResult> {
  const object = ctx.metadata.object(objectName);
  if (
    !object ||
    !(DUPLICATE_OBJECTS as readonly string[]).includes(objectName) ||
    !objectAccess(ctx.permissions, objectName).read
  )
    throw new RecordError('not_found');
  const losers = [...new Set(input.duplicateIds)];
  if (losers.length < 1 || losers.length > 2 || losers.includes(input.masterId))
    throw new RecordError('invalid', [{ field: 'duplicateIds', code: 'one_or_two_others' }]);
  const all = [input.masterId, ...losers];
  for (const id of all)
    if (!(await hasAccess(tx, ctx, object, id, 'read'))) throw new RecordError('not_found');
  const access = objectAccess(ctx.permissions, objectName);
  if (!access.edit || !access.delete) throw new RecordError('forbidden');
  if (!(await hasAccess(tx, ctx, object, input.masterId, 'edit')))
    throw new RecordError('forbidden');
  for (const id of losers)
    if (!(await hasAccess(tx, ctx, object, id, 'full')))
      throw new RecordError('forbidden', [{ field: 'duplicateIds', code: 'cannot_delete' }]);

  // Lock in id order so two merges of overlapping records queue instead of deadlocking.
  await sql`SELECT 1 FROM ${sql.table(ident(object.table))}
    WHERE tenant_id = ${tx.context.tenantId}::uuid AND id = ANY (${uuids(all)})
    ORDER BY id FOR UPDATE`.execute(tx.kysely);
  const stored = new Map<string, Record<string, unknown>>();
  for (const id of all) {
    const row = await readStored(tx, object, id);
    if (!row) throw new RecordError('not_found');
    if (object.apiName === 'lead' && row.values['converted_at'])
      throw new RecordError('conflict', [{ field: '_record', code: 'record_locked' }]);
    stored.set(id, row.values);
  }

  // The survivor's new values: each chosen field from its record (readable and editable only).
  const fields: Record<string, unknown> = {};
  for (const [name, source] of Object.entries(input.fields ?? {})) {
    if (!all.includes(source))
      throw new RecordError('invalid', [{ field: `fields.${name}`, code: 'not_a_merged_record' }]);
    const f = object.fields.find((x) => x.apiName === name);
    if (!f || !fieldAccess(ctx.permissions, objectName, name, f).read)
      throw new RecordError('invalid', [{ field: `fields.${name}`, code: 'unknown_field' }]);
    if (source === input.masterId) continue;
    const value = stored.get(source)?.[name] ?? null;
    if (JSON.stringify(value) !== JSON.stringify(stored.get(input.masterId)?.[name] ?? null))
      fields[name] = value;
  }

  const reparented = await reparent(tx, ctx, object, input.masterId, losers);
  const updated = await updateRecord(
    tx,
    ctx,
    objectName,
    input.masterId,
    { fields },
    input.version ?? null,
    { duplicates: 'skip' },
  );
  for (const id of losers) {
    await deleteRecord(tx, ctx, objectName, id);
    await sql`UPDATE ${sql.table(ident(object.table))} SET merged_into_id = ${input.masterId}::uuid
      WHERE tenant_id = ${tx.context.tenantId}::uuid AND id = ${id}::uuid`.execute(tx.kysely);
  }
  // Review-queue entries naming a merged record are resolved.
  await tx.prisma.duplicateCandidate.updateMany({
    where: { object: objectName, status: 'OPEN', recordIds: { hasSome: all } },
    data: { status: 'MERGED', resolvedAt: new Date(), resolvedBy: ctx.userId },
  });
  await tx.prisma.fieldHistory.create({
    data: {
      tenantId: tx.context.tenantId,
      object: objectName,
      recordId: input.masterId,
      field: '_merged',
      oldValue: null as never,
      newValue: losers as never,
      changedBy: ctx.userId,
      requestId: ctx.requestId ?? null,
    },
  });
  await audit.record(tx, {
    action: 'record.merged',
    object: objectName,
    recordId: input.masterId,
    payload: { merged: losers, fields: Object.keys(fields), reparented },
    ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
  });
  await outbox.emit(tx, {
    topic: 'automation.record_merged',
    aggregateType: objectName,
    aggregateId: input.masterId,
    payload: {
      object: objectName,
      id: input.masterId,
      changedFields: Object.keys(fields),
      merged: losers,
    },
  });
  return { id: input.masterId, version: updated.version, merged: losers, reparented };
}
