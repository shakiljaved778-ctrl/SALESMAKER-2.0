import type { FieldMeta, FieldType, MetadataIndex, ObjectMeta } from '@sm/metadata';
import { fieldAccess, objectAccess, type EffectivePermissions } from '@sm/permissions';
import { sql, type Expression, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { z } from 'zod';

import {
  filterFields,
  filterSqlWith,
  parseFilter,
  PathFilterSchema,
  type FilterNode,
} from './filter.js';
import { sharingPredicate, type SharingContext } from './sharing-predicate.js';

/**
 * SMQ (§3.8): the one read path for CRM lists, related lists, search post-filtering, reports and
 * AI. A query is JSON, validated here, resolved through metadata as the caller (FLS), and
 * compiled to SQL with the caller's sharing predicate, keyset pagination and bound values only.
 */
export const MAX_RELATIONSHIP_DEPTH = 3;
export const COUNT_CAP = 100_000;

const Path = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}(\.[a-z][a-z0-9_]{0,62}){0,3}$/, 'Must be a field API name or path');

export const SmqSchema = z
  .object({
    object: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
    fields: z.array(Path).min(1).max(100),
    where: PathFilterSchema.optional(),
    orderBy: z
      .array(z.object({ field: Path, direction: z.enum(['asc', 'desc']).default('asc') }).strict())
      .max(3)
      .optional(),
    limit: z.number().int().min(1).max(2000).default(50),
    cursor: z.string().max(4000).optional(),
    /** Records the caller viewed most recently first (list view "Recently viewed"). */
    scope: z.enum(['all', 'recent']).default('all'),
  })
  .strict();
export type Smq = z.input<typeof SmqSchema>;

export class QueryError extends Error {
  constructor(
    readonly code:
      | 'unknown_object'
      | 'unknown_field'
      | 'field_not_readable'
      | 'not_sortable'
      | 'too_deep'
      | 'invalid_cursor'
      | 'invalid_filter'
      | 'limit_too_high',
    readonly field?: string,
  ) {
    super(field ? `${code}: ${field}` : code);
  }
}

export interface QueryContext {
  userId: string;
  metadata: MetadataIndex;
  permissions: EffectivePermissions;
  sharing: SharingContext;
  /** 200 for the UI, 2000 for the API (§3.8). */
  maxLimit: number;
  /**
   * Also return each record's `version` (for If-Match) and, on objects with money, its
   * `currencyCode` (the currency of its money fields). Off by default.
   */
  recordMeta?: boolean;
}

/** A lookup value: the related record's id and, when the caller may see it, its name. */
export interface LookupValue {
  id: string;
  name: string | null;
  object: string | null;
}

export interface QueryRecord {
  id: string;
  [field: string]: unknown;
}

export interface QueryPage {
  records: QueryRecord[];
  /** Opaque; pass back as `cursor` for the next page. Null on the last page. */
  nextCursor: string | null;
}

type Sql = RawBuilder<unknown>;

/** Platform tables lookups can point at (not CRM objects): no sharing, fixed name columns. */
const PLATFORM: Record<string, { table: string; name: Sql; fields: Record<string, Sql> }> = {
  user: {
    table: 'user',
    name: sql`name`,
    fields: { id: sql`id`, name: sql`name`, email: sql`email::text`, title: sql`title` },
  },
  queue: { table: 'queue', name: sql`name`, fields: { id: sql`id`, name: sql`name` } },
  record_type: {
    table: 'record_type',
    name: sql`name`,
    fields: { id: sql`id`, name: sql`name`, api_name: sql`api_name` },
  },
  pipeline: { table: 'pipeline', name: sql`name`, fields: { id: sql`id`, name: sql`name` } },
};

const LOOKUP_TYPES: ReadonlySet<FieldType> = new Set(['lookup', 'master_detail', 'user']);
const UNSORTABLE: ReadonlySet<FieldType> = new Set([
  'long_text',
  'rich_text',
  'multi_picklist',
  'geolocation',
  'formula',
]);

const CUSTOM_CAST: Partial<Record<FieldType, string>> = {
  number: 'numeric',
  currency: 'numeric',
  percent: 'numeric',
  date: 'date',
  datetime: 'timestamptz',
  checkbox: 'boolean',
  lookup: 'uuid',
  master_detail: 'uuid',
  user: 'uuid',
};

/** The relationship name a lookup is followed by (`account_id` → `account`). */
function relationshipName(f: FieldMeta): string {
  if (f.relationshipName) return f.relationshipName;
  if (f.apiName.endsWith('__c')) return `${f.apiName.slice(0, -3)}__r`;
  return f.apiName.replace(/_id$/, '');
}

/** SQL for a field of `alias`, as its natural type. */
function fieldExpr(alias: string, f: FieldMeta): Sql {
  if (f.storage.kind === 'column') return sql`${sql.ref(`${alias}.${f.storage.column}`)}`;
  const key = f.storage.key;
  if (f.type === 'multi_picklist') return sql`(${sql.ref(`${alias}.custom`)} -> ${key})`;
  const cast = CUSTOM_CAST[f.type];
  const text = sql`(${sql.ref(`${alias}.custom`)} ->> ${key})`;
  return cast ? sql`(${text})::${sql.raw(cast)}` : text;
}

/** How a value leaves the database: text for exact numbers, dates and microsecond timestamps. */
function projected(f: FieldMeta, e: Sql): Sql {
  switch (f.type) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'rollup_summary':
      return sql`(${e})::text`;
    case 'date':
      return sql`to_char(${e}, 'YYYY-MM-DD')`;
    case 'datetime':
      return sql`to_char((${e}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    case 'time':
      return sql`to_char(${e}, 'HH24:MI:SS')`;
    default:
      return e;
  }
}

interface Join {
  alias: string;
  target: string;
  platform: boolean;
  on: Sql;
}

interface Resolved {
  expr: Sql;
  field: FieldMeta | null;
  /** For platform fields (user.email …) the SQL type is text. */
  type: FieldType;
}

class Compiler {
  private readonly joins = new Map<string, Join>();
  private readonly root: ObjectMeta;

  constructor(
    private readonly ctx: QueryContext,
    private readonly objectName: string,
  ) {
    const root = ctx.metadata.object(objectName);
    if (!root || !objectAccess(ctx.permissions, objectName).read)
      throw new QueryError('unknown_object');
    this.root = root;
  }

  private readable(object: string, f: FieldMeta): boolean {
    return fieldAccess(this.ctx.permissions, object, f.apiName, f).read;
  }

  /** Join (once) the record a lookup points at; CRM targets carry their own sharing predicate. */
  private join(fromAlias: string, lookup: FieldMeta, depth: number): Join {
    const key = `${fromAlias}.${lookup.apiName}`;
    const existing = this.joins.get(key);
    if (existing) return existing;
    const target = lookup.referenceTo[0] ?? (lookup.type === 'user' ? 'user' : '');
    const alias = `j${String(this.joins.size + 1)}`;
    const platform = PLATFORM[target];
    const idRef = fieldExpr(fromAlias, lookup);
    let on: Sql;
    if (platform) {
      on = sql`${sql.ref(`${alias}.tenant_id`)} = ${sql.ref(`${fromAlias}.tenant_id`)} AND ${sql.ref(`${alias}.id`)} = ${idRef}`;
    } else {
      const meta = this.ctx.metadata.object(target);
      if (!meta || !objectAccess(this.ctx.permissions, target).read)
        throw new QueryError('field_not_readable', lookup.apiName);
      on = sql`${sql.ref(`${alias}.tenant_id`)} = ${sql.ref(`${fromAlias}.tenant_id`)} AND ${sql.ref(`${alias}.id`)} = ${idRef} AND ${sql.ref(`${alias}.deleted_at`)} IS NULL AND ${sharingPredicate(this.ctx.sharing, target, alias, 'read')}`;
    }
    if (depth > MAX_RELATIONSHIP_DEPTH) throw new QueryError('too_deep', lookup.apiName);
    const join = { alias, target, platform: Boolean(platform), on };
    this.joins.set(key, join);
    return join;
  }

  /** Resolve `field` or `a.b.c` from the root, checking FLS at every step. */
  resolve(path: string): Resolved {
    const segments = path.split('.');
    let object = this.root.apiName;
    let alias = 'r';
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i] ?? '';
      const last = i === segments.length - 1;
      const platform = PLATFORM[object];
      if (platform) {
        const expr = last ? platform.fields[segment] : undefined;
        if (!expr) throw new QueryError('unknown_field', path);
        return { expr: sql`${sql.ref(alias)}.${expr}`, field: null, type: 'text' };
      }
      const meta = this.ctx.metadata.object(object);
      if (!meta) throw new QueryError('unknown_field', path);
      if (last) {
        const f = this.ctx.metadata.field(object, segment);
        if (!f) throw new QueryError('unknown_field', path);
        if (!this.readable(object, f)) throw new QueryError('field_not_readable', path);
        return { expr: fieldExpr(alias, f), field: f, type: f.type };
      }
      const lookup = meta.fields.find(
        (f) => LOOKUP_TYPES.has(f.type) && relationshipName(f) === segment,
      );
      if (!lookup) throw new QueryError('unknown_field', path);
      if (!this.readable(object, lookup)) throw new QueryError('field_not_readable', path);
      const join = this.join(alias, lookup, i + 1);
      alias = join.alias;
      object = join.target;
    }
    throw new QueryError('unknown_field', path);
  }

  /** The display name of a joined record, from the name fields its reader can see. */
  private nameOf(join: Join): Sql {
    const platform = PLATFORM[join.target];
    if (platform) return sql`${sql.ref(join.alias)}.${platform.name}`;
    const parts = this.ctx.metadata.nameFields(join.target).flatMap((n) => {
      const f = this.ctx.metadata.field(join.target, n);
      return f && this.readable(join.target, f) ? [fieldExpr(join.alias, f)] : [];
    });
    return parts.length ? sql`NULLIF(concat_ws(' ', ${sql.join(parts)}), '')` : sql`NULL::text`;
  }

  /** Select list entries: `[key, sql]`. Lookups become `{ id, name }`. */
  projection(paths: readonly string[]): { key: string; sql: Sql; lookup: boolean }[] {
    const out: { key: string; sql: Sql; lookup: boolean }[] = [];
    for (const path of paths) {
      if (path === 'id') continue;
      let resolved: Resolved;
      try {
        resolved = this.resolve(path);
      } catch (err) {
        // Hidden fields are left out of the projection, never an error (§6.5).
        if (err instanceof QueryError && err.code === 'field_not_readable') continue;
        throw err;
      }
      const f = resolved.field;
      if (f && LOOKUP_TYPES.has(f.type) && !path.includes('.')) {
        const join = this.join('r', f, 1);
        out.push({
          key: path,
          sql: sql`CASE WHEN ${resolved.expr} IS NULL THEN NULL ELSE json_build_object('id', ${resolved.expr}, 'name', ${this.nameOf(join)}, 'object', ${join.target}::text, 'accessible', ${sql.ref(`${join.alias}.id`)} IS NOT NULL) END`,
          lookup: true,
        });
        continue;
      }
      out.push({ key: path, sql: f ? projected(f, resolved.expr) : resolved.expr, lookup: false });
    }
    return out;
  }

  where(node: FilterNode): Expression<SqlBool> {
    for (const field of filterFields(node)) this.resolve(field); // unknown or hidden: error
    return filterSqlWith(
      (field) => this.resolve(field).expr,
      node,
      (_field, v) => (v === '$me' ? this.ctx.userId : v),
    );
  }

  sortKey(path: string): { expr: Sql; field: FieldMeta | null } {
    const r = this.resolve(path);
    if (r.field && UNSORTABLE.has(r.field.type)) throw new QueryError('not_sortable', path);
    return { expr: r.expr, field: r.field };
  }

  joinClauses(): Sql[] {
    return [...this.joins.values()].map(
      (j) =>
        sql`LEFT JOIN ${sql.table(PLATFORM[j.target]?.table ?? j.target)} AS ${sql.raw(j.alias)} ON ${j.on}`,
    );
  }
}

type CursorValue = string | number | boolean | null;

function encodeCursor(values: CursorValue[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, length: number): CursorValue[] {
  try {
    const values = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(values) &&
      values.length === length &&
      values.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)) &&
      typeof values.at(-1) === 'string'
    )
      return values as CursorValue[];
  } catch {
    /* fall through */
  }
  throw new QueryError('invalid_cursor');
}

/**
 * Rows after the cursor for keys ordered `ASC NULLS LAST` / `DESC NULLS FIRST` (Postgres's
 * defaults, so an index can be scanned either way), ending with the id.
 */
function after(keys: { expr: Sql; dir: 'asc' | 'desc' }[], values: CursorValue[]): Sql {
  const branches: Sql[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i] as { expr: Sql; dir: 'asc' | 'desc' };
    const v = values[i] ?? null;
    const equal = keys
      .slice(0, i)
      .map((k, j) => sql`${k.expr} IS NOT DISTINCT FROM ${values[j] ?? null}`);
    let greater: Sql;
    if (key.dir === 'asc')
      greater = v === null ? sql`FALSE` : sql`(${key.expr} > ${v} OR ${key.expr} IS NULL)`;
    else greater = v === null ? sql`${key.expr} IS NOT NULL` : sql`${key.expr} < ${v}`;
    branches.push(equal.length ? sql`(${sql.join([...equal, greater], sql` AND `)})` : greater);
  }
  return sql`(${sql.join(branches, sql` OR `)})`;
}

/** A validated query, compiled for one caller. */
export interface CompiledQuery {
  sql: RawBuilder<Record<string, unknown>>;
  countSql: RawBuilder<{ n: string | number }>;
  limit: number;
  toPage(rows: Record<string, unknown>[]): QueryPage;
}

export function compileQuery(input: unknown, ctx: QueryContext): CompiledQuery {
  const parsed = SmqSchema.safeParse(input);
  if (!parsed.success) throw new QueryError('invalid_filter');
  const q = parsed.data;
  if (q.where) {
    try {
      parseFilter(q.where, { paths: true });
    } catch {
      throw new QueryError('invalid_filter');
    }
  }
  if (q.limit > ctx.maxLimit) throw new QueryError('limit_too_high');
  const c = new Compiler(ctx, q.object);

  const conditions: Sql[] = [
    sql`r.deleted_at IS NULL`,
    sql`${sharingPredicate(ctx.sharing, q.object, 'r', 'read')}`,
  ];
  if (q.where) conditions.push(sql`${c.where(q.where)}`);

  // Sort keys, then the id in the direction of the last key (one index scan direction).
  const order = q.scope === 'recent' ? [] : (q.orderBy ?? []);
  const keys = order.map((o) => ({ ...c.sortKey(o.field), dir: o.direction }));
  if (q.scope === 'recent') keys.push({ expr: sql`ri.viewed_at`, field: null, dir: 'desc' });
  const idDir = keys.at(-1)?.dir ?? 'asc';
  const allKeys = [...keys, { expr: sql`r.id`, field: null, dir: idDir }];
  if (q.cursor) conditions.push(after(allKeys, decodeCursor(q.cursor, allKeys.length)));

  const select = c.projection(q.fields);
  const joins = c.joinClauses();
  const from = sql`${sql.table(q.object)} AS r ${
    q.scope === 'recent'
      ? sql`JOIN recent_item ri ON ri.tenant_id = r.tenant_id AND ri.user_id = ${ctx.userId}::uuid AND ri.object = ${q.object} AND ri.record_id = r.id `
      : sql``
  }${sql.join(joins, sql` `)}`;
  const whereSql = sql.join(conditions, sql` AND `);
  const orderSql = sql.join(
    allKeys.map(
      (k) => sql`${k.expr} ${sql.raw(k.dir === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS FIRST')}`,
    ),
  );
  const cursorCols = allKeys.map(
    (k, i) =>
      sql`${k.field ? projected(k.field, k.expr) : sql`(${k.expr})::text`} AS ${sql.id(`__k${String(i)}`)}`,
  );
  const money =
    ctx.recordMeta === true &&
    (ctx.metadata.object(q.object)?.fields.some((f) => f.isStandard && f.type === 'currency') ??
      false);
  const columns = [
    sql`r.id`,
    ...select.map((s) => sql`${s.sql} AS ${sql.id(s.key)}`),
    ...cursorCols,
    ...(ctx.recordMeta ? [sql`r.version AS __version`] : []),
    ...(money ? [sql`r.currency_code AS __currency`] : []),
  ];
  const query = sql<
    Record<string, unknown>
  >`SELECT ${sql.join(columns)} FROM ${from} WHERE ${whereSql} ORDER BY ${orderSql} LIMIT ${q.limit + 1}`;
  const countSql = sql<{
    n: string | number;
  }>`SELECT count(*) AS n FROM (SELECT 1 FROM ${from} WHERE ${whereSql} LIMIT ${COUNT_CAP + 1}) s`;

  return {
    sql: query,
    countSql,
    limit: q.limit,
    toPage(rows) {
      const more = rows.length > q.limit;
      const page = more ? rows.slice(0, q.limit) : rows;
      const records = page.map((row) => {
        const record: QueryRecord = { id: String(row['id']) };
        for (const s of select) {
          const v = row[s.key];
          if (s.lookup && v && typeof v === 'object') {
            const l = v as { id: string; name: string | null; object: string; accessible: boolean };
            record[s.key] = {
              id: l.id,
              name: l.accessible ? l.name : null,
              object: l.object,
            } satisfies LookupValue;
          } else record[s.key] = v ?? null;
        }
        if (ctx.recordMeta) record['version'] = Number(row['__version']);
        if (money) record['currencyCode'] = row['__currency'] ?? null;
        return record;
      });
      const last = page.at(-1);
      const nextCursor =
        more && last
          ? encodeCursor(allKeys.map((_, i) => (last[`__k${String(i)}`] ?? null) as CursorValue))
          : null;
      return { records, nextCursor };
    },
  };
}

/** Run a query in the caller's tenant transaction. */
export async function runQuery<DB>(
  db: Kysely<DB>,
  input: unknown,
  ctx: QueryContext,
): Promise<QueryPage> {
  const compiled = compileQuery(input, ctx);
  const result = await compiled.sql.execute(db);
  return compiled.toPage(result.rows);
}

/** Matching records, counted up to `COUNT_CAP` ("12,408" or "100k+"). */
export async function countQuery<DB>(
  db: Kysely<DB>,
  input: unknown,
  ctx: QueryContext,
): Promise<{ count: number; capped: boolean }> {
  const compiled = compileQuery(input, ctx);
  const result = await compiled.countSql.execute(db);
  const n = Number(result.rows[0]?.n ?? 0);
  return { count: Math.min(n, COUNT_CAP), capped: n > COUNT_CAP };
}
