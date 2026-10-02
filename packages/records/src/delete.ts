import { audit, outbox, type TenantTransaction } from '@sm/db';
import type { MetadataIndex, ObjectMeta } from '@sm/metadata';
import { objectAccess } from '@sm/permissions';
import { sharingPredicate } from '@sm/query-engine';
import { sql } from 'kysely';

import type { RecordContext } from './context.js';
import { RecordError } from './errors.js';
import { syncAfterWrite } from './shares.js';
import { ident, readStored } from './storage.js';

/** Days a deleted record stays restorable (§7.5). */
export const RECYCLE_DAYS = 30;

/**
 * What goes to the bin with a record (§7.5, Salesforce semantics): an account takes its contacts
 * and opportunities. Link rows (contact roles, relations, campaign members) stay and are hidden
 * with the records they link; they are removed when the records are purged.
 */
export const CASCADES: Readonly<
  Record<string, readonly (readonly [object: string, field: string])[]>
> = {
  account: [
    ['contact', 'account_id'],
    ['opportunity', 'account_id'],
  ],
};

/** Link tables cleaned when a record is purged: table → columns that may point at it. */
const LINKS: Readonly<Record<string, readonly string[]>> = {
  account_contact_relation: ['account_id', 'contact_id'],
  opportunity_contact_role: ['opportunity_id', 'contact_id'],
  campaign_member: ['campaign_id', 'lead_id', 'contact_id'],
  account_team_member: ['account_id'],
  opportunity_team_member: ['opportunity_id'],
  recent_item: ['record_id'],
};

/** What derived shares depend on: the owner and the parent account. */
const derivedOf = (values: Record<string, unknown>) => ({
  owner: values['owner_id'],
  account: values['account_id'],
});

function objectOf(ctx: RecordContext, name: string): ObjectMeta {
  const object = ctx.metadata.object(name);
  if (!object || !objectAccess(ctx.permissions, name).read) throw new RecordError('not_found');
  return object;
}

async function visible(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: ObjectMeta,
  id: string,
  level: 'read' | 'full',
) {
  const rows = await sql`
    SELECT 1 FROM ${sql.table(ident(object.table))} AS r
    WHERE r.tenant_id = ${tx.context.tenantId}::uuid AND r.id = ${id}::uuid AND r.deleted_at IS NULL
      AND ${sharingPredicate(ctx.sharing, object.apiName, 'r', level)}`.execute(tx.kysely);
  return rows.rows.length > 0;
}

/** A record's display name, from its name fields. */
async function displayName(
  tx: TenantTransaction,
  metadata: MetadataIndex,
  object: ObjectMeta,
  id: string,
) {
  const parts = metadata.nameFields(object.apiName).map((n) => sql.ref(`r.${ident(n)}`));
  const rows = await sql<{ name: string | null }>`
    SELECT NULLIF(concat_ws(' ', ${sql.join(parts)}), '') AS name FROM ${sql.table(ident(object.table))} AS r
    WHERE r.tenant_id = ${tx.context.tenantId}::uuid AND r.id = ${id}::uuid`.execute(tx.kysely);
  return rows.rows[0]?.name ?? '';
}

async function softDelete(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: ObjectMeta,
  id: string,
  cascadeOf: string | null,
): Promise<string> {
  const now = ctx.now?.() ?? new Date();
  const name = await displayName(tx, ctx.metadata, object, id);
  await sql`
    UPDATE ${sql.table(ident(object.table))}
    SET deleted_at = ${now.toISOString()}::timestamptz, version = version + 1,
      updated_by = ${ctx.userId}::uuid, updated_at = now()
    WHERE tenant_id = ${tx.context.tenantId}::uuid AND id = ${id}::uuid`.execute(tx.kysely);
  const item = await tx.prisma.recycleBinItem.create({
    data: {
      tenantId: tx.context.tenantId,
      object: object.apiName,
      recordId: id,
      name,
      deletedAt: now,
      deletedBy: ctx.userId,
      cascadeOf,
      purgeAfter: new Date(now.getTime() + RECYCLE_DAYS * 86_400_000),
    },
  });
  return item.id;
}

/**
 * Delete a record to the recycle bin (§7.5): it needs the object's Delete permission and Full
 * access to the record (owner, above the owner, Modify All). Children in `CASCADES` go with it.
 */
export async function deleteRecord(
  tx: TenantTransaction,
  ctx: RecordContext,
  objectName: string,
  id: string,
): Promise<{ recycleBinItemId: string; cascaded: number }> {
  const object = objectOf(ctx, objectName);
  if (!(await visible(tx, ctx, object, id, 'read'))) throw new RecordError('not_found');
  if (
    !objectAccess(ctx.permissions, objectName).delete ||
    !(await visible(tx, ctx, object, id, 'full'))
  )
    throw new RecordError('forbidden');
  const before = await readStored(tx, object, id);
  const itemId = await softDelete(tx, ctx, object, id, null);
  const gone: [string, Record<string, unknown>, string][] = [
    [objectName, before?.values ?? {}, id],
  ];
  let cascaded = 0;
  for (const [childName, field] of CASCADES[objectName] ?? []) {
    const child = ctx.metadata.object(childName);
    if (!child) continue;
    const rows = await sql<{ id: string }>`
      SELECT id FROM ${sql.table(ident(child.table))}
      WHERE tenant_id = ${tx.context.tenantId}::uuid AND ${sql.ref(ident(field))} = ${id}::uuid AND deleted_at IS NULL
      FOR UPDATE`.execute(tx.kysely);
    for (const row of rows.rows) {
      const values = (await readStored(tx, child, row.id))?.values ?? {};
      await softDelete(tx, ctx, child, row.id, itemId);
      gone.push([childName, values, row.id]);
      cascaded += 1;
    }
  }
  for (const [name, values, recordId] of gone)
    await syncAfterWrite(tx, name, recordId, derivedOf(values), null);
  await audit.record(tx, {
    action: 'record.deleted',
    object: objectName,
    recordId: id,
    payload: { cascaded },
    ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
  });
  await outbox.emit(tx, {
    topic: 'automation.record_deleted',
    aggregateType: objectName,
    aggregateId: id,
    payload: { object: objectName, id, changedFields: [] },
  });
  return { recycleBinItemId: itemId, cascaded };
}

/**
 * Restore a record from the recycle bin with whatever went to the bin with it. Allowed to whoever
 * deleted it and to users who may modify all data; a record that was deleted with its parent is
 * restored by restoring the parent.
 */
export async function undeleteRecord(
  tx: TenantTransaction,
  ctx: RecordContext,
  objectName: string,
  id: string,
): Promise<{ restored: number }> {
  objectOf(ctx, objectName);
  const item = await tx.prisma.recycleBinItem.findFirst({
    where: { object: objectName, recordId: id },
  });
  if (!item) throw new RecordError('not_found');
  const admin = ctx.permissions.system.has('modify_all_data');
  if (item.deletedBy !== ctx.userId && !admin) throw new RecordError('not_found');
  if (item.cascadeOf)
    throw new RecordError('conflict', [{ field: '_record', code: 'restore_parent' }]);
  const children = await tx.prisma.recycleBinItem.findMany({ where: { cascadeOf: item.id } });
  for (const entry of [item, ...children]) {
    const meta = ctx.metadata.object(entry.object);
    if (!meta) continue;
    await sql`
      UPDATE ${sql.table(ident(meta.table))}
      SET deleted_at = NULL, version = version + 1, updated_by = ${ctx.userId}::uuid, updated_at = now()
      WHERE tenant_id = ${tx.context.tenantId}::uuid AND id = ${entry.recordId}::uuid`.execute(
      tx.kysely,
    );
  }
  for (const entry of [item, ...children]) {
    const meta = ctx.metadata.object(entry.object);
    const values = meta ? (await readStored(tx, meta, entry.recordId))?.values : undefined;
    if (values) await syncAfterWrite(tx, entry.object, entry.recordId, null, derivedOf(values));
  }
  await tx.prisma.recycleBinItem.deleteMany({
    where: { id: { in: [item.id, ...children.map((c) => c.id)] } },
  });
  await audit.record(tx, {
    action: 'record.restored',
    object: objectName,
    recordId: id,
    payload: { restored: children.length + 1 },
  });
  await outbox.emit(tx, {
    topic: 'automation.record_restored',
    aggregateType: objectName,
    aggregateId: id,
    payload: { object: objectName, id, changedFields: [] },
  });
  return { restored: children.length + 1 };
}

/**
 * Hard-delete what has been in the bin past its purge date (or everything in `ids`), with its
 * shares and links, and clear lookups that pointed at it. A maintenance job, not a user action;
 * it runs in system context inside the tenant transaction. Returns the records purged.
 */
export async function purgeRecycleBin(
  tx: TenantTransaction,
  metadata: MetadataIndex,
  options: { now?: Date; ids?: readonly string[]; limit?: number } = {},
): Promise<number> {
  const items = await tx.prisma.recycleBinItem.findMany({
    where: options.ids
      ? { id: { in: [...options.ids] } }
      : { purgeAfter: { lte: options.now ?? new Date() } },
    orderBy: { purgeAfter: 'asc' },
    take: options.limit ?? 1000,
  });
  if (items.length === 0) return 0;
  const byObject = new Map<string, string[]>();
  for (const item of items)
    byObject.set(item.object, [...(byObject.get(item.object) ?? []), item.recordId]);
  await hardDelete(tx, metadata, byObject, { deletedOnly: true });
  await tx.prisma.recycleBinItem.deleteMany({ where: { id: { in: items.map((i) => i.id) } } });
  return items.length;
}

/**
 * Remove records for good, with their shares and link rows, and clear lookups that pointed at
 * them. For the purge (records in the bin) and for undoing a lead conversion (records it created
 * that nobody touched since). Not a user action: callers decide who may.
 */
export async function hardDelete(
  tx: TenantTransaction,
  metadata: MetadataIndex,
  byObject: ReadonlyMap<string, readonly string[]>,
  options: { deletedOnly?: boolean } = {},
): Promise<void> {
  const tenantId = tx.context.tenantId;
  const allIds = [...byObject.values()].flat();
  if (allIds.length === 0) return;
  for (const [objectName, ids] of byObject) {
    const meta = metadata.object(objectName);
    if (!meta || ids.length === 0) continue;
    const idList = sql`${sql.val([...ids])}::uuid[]`;
    await sql`DELETE FROM record_share WHERE tenant_id = ${tenantId}::uuid AND object = ${objectName} AND record_id = ANY (${idList})`.execute(
      tx.kysely,
    );
    await sql`DELETE FROM ${sql.table(ident(meta.table))} WHERE tenant_id = ${tenantId}::uuid AND id = ANY (${idList})
      ${options.deletedOnly ? sql`AND deleted_at IS NOT NULL` : sql``}`.execute(tx.kysely);
    // Lookups elsewhere that pointed at these records now point nowhere.
    for (const other of metadata.metadata.objects)
      for (const f of other.fields)
        if (f.referenceTo.includes(objectName) && f.storage.kind === 'column')
          await sql`UPDATE ${sql.table(ident(other.table))} SET ${sql.ref(ident(f.storage.column))} = NULL
            WHERE tenant_id = ${tenantId}::uuid AND ${sql.ref(ident(f.storage.column))} = ANY (${idList})`.execute(
            tx.kysely,
          );
  }
  const ids = sql`${sql.val(allIds)}::uuid[]`;
  for (const [table, columns] of Object.entries(LINKS))
    await sql`DELETE FROM ${sql.table(table)} WHERE tenant_id = ${tenantId}::uuid AND (${sql.join(
      columns.map((c) => sql`${sql.ref(c)} = ANY (${ids})`),
      sql` OR `,
    )})`.execute(tx.kysely);
}

/** Records a user (or anyone who owns records) still owns — queues cannot be deleted while > 0. */
export async function ownedRecordCount(
  tx: TenantTransaction,
  metadata: MetadataIndex,
  ownerId: string,
): Promise<number> {
  let total = 0;
  for (const object of metadata.metadata.objects) {
    if (!object.fields.some((f) => f.apiName === 'owner_id')) continue;
    const rows = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM ${sql.table(ident(object.table))}
      WHERE tenant_id = ${tx.context.tenantId}::uuid AND owner_id = ${ownerId}::uuid`.execute(
      tx.kysely,
    );
    total += Number(rows.rows[0]?.n ?? 0);
  }
  return total;
}
