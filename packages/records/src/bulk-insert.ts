import { audit, outbox, type TenantTransaction } from '@sm/db';
import type { ObjectMeta } from '@sm/metadata';
import { objectAccess } from '@sm/permissions';
import { evaluateRulesForRecords, sharingPredicate } from '@sm/query-engine';
import { sql, type RawBuilder } from 'kysely';

import { bulkCreate, type RowResult } from './bulk.js';
import type { RecordContext } from './context.js';
import { batchDuplicates } from './duplicates.js';
import { RecordError, type FieldError } from './errors.js';
import {
  activeRules,
  corporateColumns,
  LOOKUPS,
  missingRequired,
  objectOf,
  prepareValues,
  stripReadOnly,
  type WriteInput,
} from './service.js';
import { syncAccountShares } from './shares.js';
import { hasMoney, ident, toColumns } from './storage.js';
import { runValidationRules } from './validation.js';

/** Rows per bulkInsert call: one transaction, a handful of statements. */
export const BULK_INSERT_BATCH = 1000;
/** Rows per INSERT statement (bounded by Postgres's 65,535 bind parameters). */
const INSERT_CHUNK = 500;
/** Opportunities keep the single-row path: stages, history and pipelines are per record. */
const ROW_BY_ROW = new Set(['opportunity']);

interface Prepared {
  index: number;
  /** Required fields left blank: reported together with reference and currency errors. */
  errors: FieldError[];
  values: Record<string, unknown>;
  changed: Set<string>;
  currencyCode: string;
}

interface Insertable {
  index: number;
  id: string;
  recordNumber: string | null;
  columns: Map<string, RawBuilder<unknown>>;
  custom: Record<string, unknown>;
  changed: string[];
  values: Record<string, unknown>;
}

const failure = (index: number, err: RecordError): RowResult => ({
  index,
  ok: false,
  id: null,
  status: err.status,
  errors: err.errors,
});

/**
 * The ids each lookup field may point to, for every id any row uses: one query per field (and
 * per target object) for the whole batch instead of one per row, with the same rules as the
 * single-row path (active owners or the object's queues, readable and visible targets).
 */
async function validReferences(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: ObjectMeta,
  rows: readonly Prepared[],
): Promise<Map<string, Set<string>>> {
  const valid = new Map<string, Set<string>>();
  const tenantId = tx.context.tenantId;
  for (const f of object.fields) {
    if (!LOOKUPS.has(f.type)) continue;
    const ids = [
      ...new Set(
        rows.flatMap((r) => {
          const v = r.values[f.apiName];
          return r.changed.has(f.apiName) && typeof v === 'string' ? [v] : [];
        }),
      ),
    ];
    if (ids.length === 0) continue;
    const found = new Set<string>();
    const add = (list: { id: string }[]) => {
      for (const r of list) found.add(r.id);
    };
    if (f.apiName === 'owner_id') {
      add(
        await tx.prisma.user.findMany({
          where: { id: { in: ids }, status: 'ACTIVE', deactivatedAt: null },
          select: { id: true },
        }),
      );
      add(
        await tx.prisma.queue.findMany({
          where: { id: { in: ids }, objects: { some: { object: object.apiName } } },
          select: { id: true },
        }),
      );
    } else if (f.apiName === 'record_type_id') {
      add(
        await tx.prisma.recordType.findMany({
          where: { id: { in: ids }, active: true, objectId: object.id },
          select: { id: true },
        }),
      );
    } else if (f.referenceTo[0] === 'pipeline') {
      add(
        await tx.prisma.pipeline.findMany({
          where: { id: { in: ids }, active: true },
          select: { id: true },
        }),
      );
    } else if (f.type === 'user' || f.referenceTo[0] === 'user') {
      add(await tx.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true } }));
    } else {
      for (const target of f.referenceTo) {
        const meta = ctx.metadata.object(target);
        if (!meta || !objectAccess(ctx.permissions, target).read) continue;
        const result = await sql<{ id: string }>`
          SELECT r.id FROM ${sql.table(ident(meta.table))} AS r
          WHERE r.tenant_id = ${tenantId}::uuid AND r.id = ANY (${sql.val(ids)}::uuid[])
            AND r.deleted_at IS NULL
            AND ${sharingPredicate(ctx.sharing, target, 'r', 'read')}`.execute(tx.kysely);
        add(result.rows);
      }
    }
    valid.set(f.apiName, found);
  }
  return valid;
}

/** The SQLSTATE of a database error, however the driver wrapped it. */
function sqlState(err: unknown): string | null {
  const e = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown } | null;
  const state = /^[0-9A-Z]{5}$/;
  // Prisma wraps raw-query failures (its own code P2010) and names the SQLSTATE in the message.
  if (typeof e?.meta?.code === 'string' && state.test(e.meta.code)) return e.meta.code;
  const match = /Code: `([0-9A-Z]{5})`/.exec(typeof e?.message === 'string' ? e.message : '');
  if (match?.[1]) return match[1];
  return typeof e?.code === 'string' && state.test(e.code) && !e.code.startsWith('P')
    ? e.code
    : null;
}

/** Database refusals that belong to one row's data (constraint and value errors). */
function rowError(err: unknown): RecordError | null {
  const state = sqlState(err);
  if (state === '23505')
    return new RecordError('conflict', [{ field: '_record', code: 'duplicate_value' }]);
  if (state && (state.startsWith('23') || state.startsWith('22')))
    return new RecordError('unprocessable', [{ field: '_record', code: 'invalid_value' }]);
  return null;
}

/**
 * Create many records of one object through the §3.7 pipeline, set-based (P03 T05).
 * Every row gets what createRecord would do to it: access, FLS, types, defaults, required fields,
 * references, currency, duplicate hooks, validation rules, auto-numbers, derived shares, sharing
 * rules, audit and outbox events. The work is done per batch instead of per row: references in one
 * query per lookup field, related values for validation rules read once per batch, one multi-row
 * INSERT per chunk, shares and rule shares computed over the inserted ids, audit and events
 * written with one insert each.
 *
 * Results are per row (Salesforce's allOrNone=false): rows that fail validation are reported and
 * never inserted; a database refusal splits the chunk and retries halves to isolate the bad row.
 * Rows in one batch cannot reference each other (a lookup is checked before anything is inserted).
 */
export async function bulkInsert(
  tx: TenantTransaction,
  ctx: RecordContext,
  objectName: string,
  inputs: readonly WriteInput[],
  options: { duplicates?: 'enforce' | 'skip' } = {},
): Promise<RowResult[]> {
  if (inputs.length > BULK_INSERT_BATCH)
    throw new RecordError('invalid', [{ field: '_batch', code: 'batch_too_large' }]);
  const object = objectOf(ctx, objectName);
  if (!objectAccess(ctx.permissions, objectName).create) throw new RecordError('forbidden');
  if (ROW_BY_ROW.has(object.apiName)) {
    const results: RowResult[] = [];
    for (let i = 0; i < inputs.length; i += 200)
      for (const r of await bulkCreate(tx, ctx, objectName, inputs.slice(i, i + 200)))
        results.push({ ...r, index: r.index + i });
    return results;
  }
  const results = new Map<number, RowResult>();
  const money = hasMoney(object);

  // §3.7 steps 1–4 and the required check, in memory.
  const prepared: Prepared[] = [];
  for (const [index, input] of inputs.entries()) {
    try {
      const { values } = prepareValues(ctx, object, null, input, {});
      const errors = missingRequired(object, values, []);
      const changed = new Set(
        object.fields
          .map((f) => f.apiName)
          .filter((n) => values[n] !== undefined && values[n] !== null),
      );
      const currencyCode = (input.currencyCode ?? ctx.corporateCurrency).toUpperCase();
      prepared.push({ index, errors, values, changed, currencyCode });
    } catch (err) {
      if (!(err instanceof RecordError)) throw err;
      results.set(index, failure(index, err));
    }
  }

  // References, currency and before-save hooks.
  const references = await validReferences(tx, ctx, object, prepared);
  const checked: Prepared[] = [];
  for (const row of prepared) {
    try {
      const errors = [...row.errors];
      for (const f of object.fields) {
        const id = row.values[f.apiName];
        if (!LOOKUPS.has(f.type) || !row.changed.has(f.apiName) || typeof id !== 'string') continue;
        if (!references.get(f.apiName)?.has(id))
          errors.push({ field: f.apiName, code: 'invalid_reference' });
      }
      if (money && !(await ctx.currency.isActive(row.currencyCode)))
        errors.push({ field: 'currency_code', code: 'inactive_currency' });
      if (errors.length) throw new RecordError('unprocessable', errors);
      await ctx.hooks?.beforeSave?.(object.apiName, row.values, true);
      checked.push(row);
    } catch (err) {
      if (!(err instanceof RecordError)) throw err;
      results.set(row.index, failure(row.index, err));
    }
  }

  // Duplicate rules against stored records (one statement per rule), then validation rules.
  const duplicates = batchDuplicates(tx, ctx, object);
  const probe = (row: Prepared) => ({ index: row.index, id: null, values: row.values });
  if (options.duplicates !== 'skip') await duplicates.stored(checked.map(probe));
  const shared = new Map<string, Promise<unknown>>();
  let accepted: (Prepared & { extra: [string, unknown][] })[] = [];
  for (const row of checked) {
    try {
      const duplicate = duplicates.errors.get(row.index);
      if (duplicate) throw duplicate;
      const ruleErrors = await runValidationRules(tx, ctx, object, row.values, null, shared);
      if (ruleErrors.length) throw new RecordError('unprocessable', ruleErrors);
      const extra = money
        ? await corporateColumns(ctx, object, row.values, row.currencyCode, () => true)
        : [];
      accepted.push({ ...row, extra });
    } catch (err) {
      if (!(err instanceof RecordError)) throw err;
      results.set(row.index, failure(row.index, err));
    }
  }
  // Rows of the batch that duplicate earlier rows being saved (as if those were stored already).
  if (options.duplicates !== 'skip') {
    await duplicates.withinBatch(accepted.map(probe));
    for (const row of accepted) {
      const duplicate = duplicates.errors.get(row.index);
      if (duplicate) results.set(row.index, failure(row.index, duplicate));
    }
    accepted = accepted.filter((row) => !results.has(row.index));
  }

  // Ids (time-ordered, as the column default would draw them) and record numbers, as a block.
  const auto = object.autoNumbers.find((a) => a.field === 'record_number');
  const drawn = accepted.length
    ? await sql<{ id: string; n: string | null }>`
        SELECT uuid_generate_v7()::text AS id,
          ${auto ? sql`auto_number_next(${auto.fieldId}::uuid)::text` : sql`NULL::text`} AS n
        FROM generate_series(1, ${accepted.length}::int) AS g ORDER BY g`.execute(tx.kysely)
    : { rows: [] };
  const ids = drawn.rows.map((r) => r.id).sort();
  const numbers = drawn.rows
    .map((r) => r.n)
    .filter((n): n is string => n !== null)
    .sort((a, b) => Number(a) - Number(b));
  const rows: Insertable[] = accepted.map((row, i) => {
    const { columns, custom } = toColumns(object, stripReadOnly(object, row.values, new Set()), {});
    const n = numbers[i];
    return {
      index: row.index,
      id: ids[i] ?? '',
      recordNumber:
        auto && n !== undefined
          ? auto.format.replace(/\{(0+)\}/, (_, zeros: string) => n.padStart(zeros.length, '0'))
          : null,
      columns: new Map([
        ...columns,
        ...row.extra.map(([c, v]) => [ident(c), sql`${v}`] as [string, RawBuilder<unknown>]),
      ]),
      custom,
      changed: object.fields.map((f) => f.apiName).filter((name) => row.changed.has(name)),
      values: row.values,
    };
  });

  const inserted: Insertable[] = [];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    for (const failed of await insertIsolating(tx, ctx, object, chunk, !!auto))
      results.set(failed.row.index, failure(failed.row.index, failed.error));
    inserted.push(...chunk.filter((r) => !results.has(r.index)));
  }

  await afterInsert(tx, ctx, object, inserted);
  for (const row of inserted) {
    const alerts = duplicates.alerts.get(row.index);
    results.set(row.index, {
      index: row.index,
      ok: true,
      id: row.id,
      version: 1,
      ...(alerts?.length ? { duplicates: alerts } : {}),
    });
  }
  return inputs.map((_, index) => results.get(index) as RowResult);
}

/**
 * Insert a chunk in a savepoint. When the database refuses it for a row's data, roll back, split
 * and retry the halves until the refused rows are alone; they are returned as failures.
 */
async function insertIsolating(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: ObjectMeta,
  rows: readonly Insertable[],
  numbered: boolean,
): Promise<{ row: Insertable; error: RecordError }[]> {
  if (rows.length === 0) return [];
  await sql`SAVEPOINT sm_bulk_insert`.execute(tx.kysely);
  try {
    await insertStatement(tx, ctx, object, rows, numbered);
    await sql`RELEASE SAVEPOINT sm_bulk_insert`.execute(tx.kysely);
    return [];
  } catch (err) {
    await sql`ROLLBACK TO SAVEPOINT sm_bulk_insert`.execute(tx.kysely);
    await sql`RELEASE SAVEPOINT sm_bulk_insert`.execute(tx.kysely);
    const error = rowError(err);
    if (!error) throw err;
    const [only] = rows;
    if (rows.length === 1 && only) return [{ row: only, error }];
    const half = Math.ceil(rows.length / 2);
    return [
      ...(await insertIsolating(tx, ctx, object, rows.slice(0, half), numbered)),
      ...(await insertIsolating(tx, ctx, object, rows.slice(half), numbered)),
    ];
  }
}

/** One multi-row INSERT; a column a row does not set takes its default, as on the single path. */
async function insertStatement(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: ObjectMeta,
  rows: readonly Insertable[],
  numbered: boolean,
): Promise<void> {
  const tenantId = tx.context.tenantId;
  const columns = [...new Set(rows.flatMap((r) => [...r.columns.keys()]))];
  const head = [
    sql.ref('tenant_id'),
    sql.ref('id'),
    ...columns.map((c) => sql.ref(c)),
    sql.ref('custom'),
    sql.ref('created_by'),
    sql.ref('updated_by'),
    ...(numbered ? [sql.ref('record_number')] : []),
  ];
  const tuples = rows.map(
    (r) =>
      sql`(${sql.join([
        sql`${tenantId}::uuid`,
        sql`${r.id}::uuid`,
        ...columns.map((c) => r.columns.get(c) ?? sql`DEFAULT`),
        sql`${JSON.stringify(r.custom)}::jsonb`,
        sql`${ctx.userId}::uuid`,
        sql`${ctx.userId}::uuid`,
        ...(numbered ? [sql`${r.recordNumber}`] : []),
      ])})`,
  );
  await sql`INSERT INTO ${sql.table(ident(object.table))} (${sql.join(head)})
    VALUES ${sql.join(tuples)}`.execute(tx.kysely);
}

/** §3.7 steps 6–8 over the inserted set: derived shares, rule shares, audit and events. */
async function afterInsert(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: ObjectMeta,
  rows: readonly Insertable[],
): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 1000) {
    const slice = ids.slice(i, i + 1000);
    if (object.apiName === 'account') await syncAccountShares(tx, slice);
  }
  if (object.apiName === 'contact') {
    const accounts = [
      ...new Set(
        rows.flatMap((r) =>
          typeof r.values['account_id'] === 'string' ? [r.values['account_id']] : [],
        ),
      ),
    ].sort();
    for (let i = 0; i < accounts.length; i += 1000)
      await syncAccountShares(tx, accounts.slice(i, i + 1000));
  }
  const rules = await activeRules(tx, object.apiName);
  if (rules.length)
    await evaluateRulesForRecords(tx.kysely, {
      tenantId: tx.context.tenantId,
      recordTable: object.table,
      recordIds: ids,
      rules,
    });
  // Audit and events carry field names, never values (§6.5), as on the single-row path.
  await audit.recordMany(
    tx,
    rows.map((r) => ({
      action: 'record.created',
      object: object.apiName,
      recordId: r.id,
      payload: { fields: r.changed },
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
    })),
  );
  await outbox.emit(
    tx,
    rows.map((r) => ({
      topic: 'automation.record_created',
      aggregateType: object.apiName,
      aggregateId: r.id,
      payload: { object: object.apiName, id: r.id, changedFields: r.changed },
    })),
  );
}
