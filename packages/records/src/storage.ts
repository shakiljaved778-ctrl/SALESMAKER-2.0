import type { TenantTransaction } from '@sm/db';
import type { FieldMeta, ObjectMeta } from '@sm/metadata';
import { sql, type RawBuilder } from 'kysely';

/**
 * Moving values between the API's stored representation (decimal strings, `YYYY-MM-DD`, ISO
 * instants, arrays) and an object's table: standard fields are columns, custom fields keys of
 * `custom`. Numbers and dates are read back as text, so nothing passes through a float.
 */
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
export function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`invalid identifier ${name}`);
  return name;
}

function readExpr(
  f: FieldMeta & { storage: { kind: 'column'; column: string } },
): RawBuilder<unknown> {
  const col = sql.ref(`r.${ident(f.storage.column)}`);
  switch (f.type) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'rollup_summary':
      return sql`(${col})::text`;
    case 'date':
      return sql`to_char(${col}, 'YYYY-MM-DD')`;
    case 'datetime':
      return sql`to_char((${col}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    case 'time':
      return sql`to_char(${col}, 'HH24:MI:SS')`;
    default:
      return sql`${col}`;
  }
}

export interface StoredRecord {
  id: string;
  version: number;
  deletedAt: string | null;
  /** Field API name → stored value (custom fields included). */
  values: Record<string, unknown>;
  /** Extra columns the pipeline needs that are not fields. */
  currencyCode: string | null;
  custom: Record<string, unknown>;
}

/** Money objects carry a currency code column (§4.1). */
export const hasMoney = (object: ObjectMeta): boolean =>
  object.fields.some((f) => f.isStandard && f.type === 'currency');

/** One record's stored values, optionally locked for the write (`FOR UPDATE`). */
export async function readStored(
  tx: TenantTransaction,
  object: ObjectMeta,
  id: string,
  options: { lock?: boolean; includeDeleted?: boolean } = {},
): Promise<StoredRecord | null> {
  const columns = object.fields.flatMap((f) =>
    f.storage.kind === 'column'
      ? [
          sql`${readExpr(f as FieldMeta & { storage: { kind: 'column'; column: string } })} AS ${sql.id(f.apiName)}`,
        ]
      : [],
  );
  const money = hasMoney(object);
  const rows = await sql<Record<string, unknown>>`
    SELECT ${sql.join(columns)}, r.custom AS __custom, r.version AS __version,
      to_char(r.deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS __deleted_at
      ${money ? sql`, r.currency_code AS __currency` : sql``}
    FROM ${sql.table(ident(object.table))} AS r
    WHERE r.tenant_id = ${tx.context.tenantId}::uuid AND r.id = ${id}::uuid
      ${options.includeDeleted ? sql`` : sql`AND r.deleted_at IS NULL`}
    ${options.lock ? sql`FOR UPDATE OF r` : sql``}`.execute(tx.kysely);
  const row = rows.rows[0];
  if (!row) return null;
  const custom = (row['__custom'] ?? {}) as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  for (const f of object.fields)
    values[f.apiName] =
      f.storage.kind === 'column' ? (row[f.apiName] ?? null) : (custom[f.storage.key] ?? null);
  return {
    id,
    version: Number(row['__version']),
    deletedAt: (row['__deleted_at'] as string | null) ?? null,
    values,
    currencyCode: (row['__currency'] as string | null | undefined) ?? null,
    custom,
  };
}

/** A stored value as a SQL parameter of the column's type. */
function param(f: FieldMeta, value: unknown): RawBuilder<unknown> {
  if (value === null || value === undefined) return sql`NULL`;
  if (f.type === 'multi_picklist') return sql`${sql.val(value as string[])}::text[]`;
  return sql`${value}`;
}

/** Split field values into column assignments and the `custom` object. */
export function toColumns(
  object: ObjectMeta,
  values: Record<string, unknown>,
  custom: Record<string, unknown>,
): { columns: [string, RawBuilder<unknown>][]; custom: Record<string, unknown> } {
  const columns: [string, RawBuilder<unknown>][] = [];
  const nextCustom = new Map(Object.entries(custom));
  for (const [name, value] of Object.entries(values)) {
    const f = object.fields.find((x) => x.apiName === name);
    if (!f) continue;
    if (f.storage.kind === 'column') columns.push([ident(f.storage.column), param(f, value)]);
    else if (value === null || value === undefined) nextCustom.delete(f.storage.key);
    else nextCustom.set(f.storage.key, value);
  }
  return { columns, custom: Object.fromEntries(nextCustom) };
}
