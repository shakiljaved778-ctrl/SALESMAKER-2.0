import type { TenantTransaction } from '@sm/db';
import { objectAccess, type SystemPermissionName } from '@sm/permissions';
import { runQuery, type FilterNode } from '@sm/query-engine';
import { sql, type RawBuilder } from 'kysely';

import type { RecordContext } from './context.js';
import { deleteRecord } from './delete.js';
import { RecordError, type FieldError } from './errors.js';
import { createRecord, updateRecord, type WriteInput } from './service.js';
import { ident } from './storage.js';

/** Rows per batch through the pipeline (§3.7): one savepoint per row, one transaction per batch. */
export const BULK_BATCH = 200;
/** "Select all matching" is capped here and runs as a job (§5.x list view, T10). */
export const MASS_JOB_LIMIT = 10_000;

export type RowResult =
  | { index: number; ok: true; id: string; version?: number }
  | { index: number; ok: false; id: string | null; status: number; errors: FieldError[] };

/**
 * Run `fn` for each item in its own savepoint, so a failing row rolls back alone and the batch
 * goes on (per-row results, Salesforce's allOrNone=false). Errors that are not RecordErrors
 * (the database is gone, a bug) abort the whole batch.
 */
async function eachRow<T>(
  tx: TenantTransaction,
  items: readonly T[],
  idOf: (item: T) => string | null,
  fn: (item: T) => Promise<{ id: string; version?: number }>,
): Promise<RowResult[]> {
  if (items.length > BULK_BATCH)
    throw new RecordError('invalid', [{ field: '_batch', code: 'batch_too_large' }]);
  const results: RowResult[] = [];
  for (const [index, item] of items.entries()) {
    await sql`SAVEPOINT sm_bulk_row`.execute(tx.kysely);
    try {
      const done = await fn(item);
      await sql`RELEASE SAVEPOINT sm_bulk_row`.execute(tx.kysely);
      results.push({ index, ok: true, ...done });
    } catch (err) {
      await sql`ROLLBACK TO SAVEPOINT sm_bulk_row`.execute(tx.kysely);
      if (!(err instanceof RecordError)) throw err;
      results.push({ index, ok: false, id: idOf(item), status: err.status, errors: err.errors });
    }
  }
  return results;
}

function requireSystem(ctx: RecordContext, name: SystemPermissionName) {
  if (!ctx.permissions.system.has(name))
    throw new RecordError('forbidden', [{ field: '_record', code: `needs_${name}` }]);
}

/** Create up to 200 records, each through the full pipeline. */
export function bulkCreate(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: string,
  inputs: readonly WriteInput[],
): Promise<RowResult[]> {
  return eachRow(
    tx,
    inputs,
    () => null,
    (input) => createRecord(tx, ctx, object, input),
  );
}

export interface BulkUpdate {
  id: string;
  input: WriteInput;
  /** Optimistic lock per row; null writes whatever the current version is. */
  version: number | null;
}

/** Update up to 200 records, each through the full pipeline. */
export function bulkUpdate(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: string,
  rows: readonly BulkUpdate[],
): Promise<RowResult[]> {
  return eachRow(
    tx,
    rows,
    (r) => r.id,
    (r) => updateRecord(tx, ctx, object, r.id, r.input, r.version),
  );
}

/** Delete up to 200 records to the recycle bin. */
export function bulkDelete(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: string,
  ids: readonly string[],
): Promise<RowResult[]> {
  return eachRow(
    tx,
    ids,
    (id) => id,
    async (id) => {
      await deleteRecord(tx, ctx, object, id);
      return { id };
    },
  );
}

/**
 * Mass update (§7.5): the same field values on each selected record. Needs `mass_update`; each
 * row still needs edit access and field edit permission, as a single update would.
 */
export function massUpdate(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: string,
  ids: readonly string[],
  input: WriteInput,
): Promise<RowResult[]> {
  requireSystem(ctx, 'mass_update');
  return bulkUpdate(
    tx,
    ctx,
    object,
    ids.map((id) => ({ id, input, version: null })),
  );
}

export interface TransferOptions {
  /** Accounts: which of the account's opportunities owned by the previous owner move too. */
  opportunities?: 'none' | 'open' | 'all';
  /** Keep the account and opportunity teams (default); otherwise they are removed. */
  keepTeams?: boolean;
}

/**
 * Mass transfer of ownership (§7.5). Needs `transfer_records` and, per record, what a single
 * transfer needs (Full access). An account takes along the contacts and, per `opportunities`,
 * the opportunities that its previous owner owned (Salesforce semantics); those move through the
 * pipeline too, so a child the user cannot transfer fails the account's row.
 */
export function massTransfer(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: string,
  ids: readonly string[],
  ownerId: string,
  options: TransferOptions = {},
): Promise<RowResult[]> {
  requireSystem(ctx, 'transfer_records');
  const opportunities = options.opportunities ?? 'open';
  const keepTeams = options.keepTeams ?? true;
  const tenantId = tx.context.tenantId;
  const transfer = async (target: string, id: string) => {
    const done = await updateRecord(tx, ctx, target, id, { fields: { owner_id: ownerId } }, null);
    if (!keepTeams && (target === 'account' || target === 'opportunity'))
      await sql`DELETE FROM ${sql.table(`${target}_team_member`)}
        WHERE tenant_id = ${tenantId}::uuid AND ${sql.ref(`${target}_id`)} = ${id}::uuid`.execute(
        tx.kysely,
      );
    return done;
  };
  return eachRow(
    tx,
    ids,
    (id) => id,
    async (id) => {
      if (object !== 'account') return transfer(object, id);
      const before = await sql<{ owner_id: string | null }>`
        SELECT owner_id FROM account WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid
          AND deleted_at IS NULL`.execute(tx.kysely);
      const previous = before.rows[0]?.owner_id ?? null;
      const done = await transfer('account', id);
      if (previous === null || previous === ownerId) return done;
      const children: [string, RawBuilder<unknown>][] = [['contact', sql`TRUE`]];
      if (opportunities !== 'none')
        children.push([
          'opportunity',
          opportunities === 'open' ? sql`is_closed = false` : sql`TRUE`,
        ]);
      for (const [child, extra] of children) {
        const rows = await sql<{ id: string }>`
          SELECT id FROM ${sql.table(ident(child))}
          WHERE tenant_id = ${tenantId}::uuid AND account_id = ${id}::uuid AND deleted_at IS NULL
            AND owner_id = ${previous}::uuid AND ${extra}`.execute(tx.kysely);
        for (const row of rows.rows) await transfer(child, row.id);
      }
      return done;
    },
  );
}

/** Mass delete (§7.5): only for users with Modify All on the object; records go to the bin. */
export function massDelete(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: string,
  ids: readonly string[],
): Promise<RowResult[]> {
  if (!objectAccess(ctx.permissions, object).modifyAll)
    throw new RecordError('forbidden', [{ field: '_record', code: 'needs_modify_all' }]);
  return bulkDelete(tx, ctx, object, ids);
}

/**
 * The ids of the records matching `where` that the user can see ("select all matching"), in id
 * order, up to `MASS_JOB_LIMIT`. Rows the user may see but not change fail individually later.
 */
export async function selectMatching(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: string,
  where: FilterNode | undefined,
  limit = MASS_JOB_LIMIT,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await runQuery(
      tx.kysely,
      {
        object,
        fields: ['id'],
        ...(where ? { where } : {}),
        orderBy: [{ field: 'id', direction: 'asc' }],
        limit: Math.min(2000, limit - ids.length),
        ...(cursor ? { cursor } : {}),
      },
      { ...ctx, maxLimit: 2000 },
    );
    ids.push(...page.records.map((r) => r.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor && ids.length < limit);
  return ids;
}
