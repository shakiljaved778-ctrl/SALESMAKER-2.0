import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import { z } from 'zod';

/** A column of the record's table: snake_case API names (§5.1). */
const FieldName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'Must be a field API name');
const Scalar = z.union([z.string().max(1000), z.number(), z.boolean()]);

export const COMPARISON_OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const;
export const TEXT_OPS = ['contains', 'starts_with'] as const;

export type FilterCondition =
  | { field: string; op: (typeof COMPARISON_OPS)[number]; value: string | number | boolean }
  | { field: string; op: (typeof TEXT_OPS)[number]; value: string }
  | { field: string; op: 'in' | 'not_in'; value: (string | number | boolean)[] }
  | { field: string; op: 'is_null' | 'is_not_null' };

export type FilterNode =
  FilterCondition | { and: FilterNode[] } | { or: FilterNode[] } | { not: FilterNode };

const Text = z.string().min(1).max(255);
const List = z.array(Scalar).min(1).max(500);
const Condition = z.discriminatedUnion('op', [
  z.object({ field: FieldName, op: z.literal('eq'), value: Scalar }),
  z.object({ field: FieldName, op: z.literal('ne'), value: Scalar }),
  z.object({ field: FieldName, op: z.literal('lt'), value: Scalar }),
  z.object({ field: FieldName, op: z.literal('lte'), value: Scalar }),
  z.object({ field: FieldName, op: z.literal('gt'), value: Scalar }),
  z.object({ field: FieldName, op: z.literal('gte'), value: Scalar }),
  z.object({ field: FieldName, op: z.literal('contains'), value: Text }),
  z.object({ field: FieldName, op: z.literal('starts_with'), value: Text }),
  z.object({ field: FieldName, op: z.literal('in'), value: List }),
  z.object({ field: FieldName, op: z.literal('not_in'), value: List }),
  z.object({ field: FieldName, op: z.literal('is_null') }),
  z.object({ field: FieldName, op: z.literal('is_not_null') }),
]);

/**
 * The filter tree (sharing-rule criteria now; list views and SMQ where-clauses in P02). Depth is
 * capped at 8 and size at 100 conditions, so a stored filter can never become an expensive query.
 */
export const FilterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    Condition,
    z.object({ and: z.array(FilterNodeSchema).min(1).max(50) }).strict(),
    z.object({ or: z.array(FilterNodeSchema).min(1).max(50) }).strict(),
    z.object({ not: FilterNodeSchema }).strict(),
  ]),
);

function measure(node: FilterNode, depth = 1): { depth: number; conditions: number } {
  if ('and' in node || 'or' in node) {
    const children = 'and' in node ? node.and : node.or;
    return children.reduce(
      (acc, child) => {
        const m = measure(child, depth + 1);
        return { depth: Math.max(acc.depth, m.depth), conditions: acc.conditions + m.conditions };
      },
      { depth, conditions: 0 },
    );
  }
  if ('not' in node) return measure(node.not, depth + 1);
  return { depth, conditions: 1 };
}

/** Validate an untrusted filter (e.g. from the API or the database). */
export function parseFilter(input: unknown): FilterNode {
  const node = FilterNodeSchema.parse(input);
  const { depth, conditions } = measure(node);
  if (depth > 8) throw new Error('Filters may nest at most 8 levels');
  if (conditions > 100) throw new Error('Filters may have at most 100 conditions');
  return node;
}

/** The fields a filter reads (to check them against FLS and the object's fields). */
export function filterFields(node: FilterNode): string[] {
  if ('and' in node) return [...new Set(node.and.flatMap(filterFields))];
  if ('or' in node) return [...new Set(node.or.flatMap(filterFields))];
  if ('not' in node) return filterFields(node.not);
  return [node.field];
}

type Value = string | number | boolean | Date | null | undefined;

function comparable(v: Value): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.getTime() : v;
}

function toComparable(v: string | number | boolean, like: Value): string | number | boolean {
  // Compare a stored date/time with the ISO string the filter holds.
  if (like instanceof Date && typeof v === 'string') return new Date(v).getTime();
  return v;
}

/**
 * Evaluate a filter against one record in memory, with SQL semantics so it always agrees with
 * `compileFilter`: a comparison involving NULL is false (so is its negation via `ne`/`not_in`),
 * text matching is case-insensitive, and `not` of an unknown stays false.
 */
export function evaluateFilter(
  node: FilterNode,
  record: Readonly<Record<string, unknown>>,
): boolean {
  return evaluate(node, record) === true;
}

/** Three-valued (SQL) logic: true, false, or null for unknown. */
function evaluate(node: FilterNode, record: Readonly<Record<string, unknown>>): boolean | null {
  if ('and' in node) {
    const results = node.and.map((n) => evaluate(n, record));
    if (results.includes(false)) return false;
    return results.includes(null) ? null : true;
  }
  if ('or' in node) {
    const results = node.or.map((n) => evaluate(n, record));
    if (results.includes(true)) return true;
    return results.includes(null) ? null : false;
  }
  if ('not' in node) {
    const inner = evaluate(node.not, record);
    return inner === null ? null : !inner;
  }
  const raw = record[node.field] as Value;
  if (node.op === 'is_null') return raw === null || raw === undefined;
  if (node.op === 'is_not_null') return !(raw === null || raw === undefined);
  const left = comparable(raw);
  if (left === null) return null;
  switch (node.op) {
    case 'in':
      return node.value.some((v) => toComparable(v, raw) === left);
    case 'not_in':
      return !node.value.some((v) => toComparable(v, raw) === left);
    case 'contains':
      return String(left).toLowerCase().includes(node.value.toLowerCase());
    case 'starts_with':
      return String(left).toLowerCase().startsWith(node.value.toLowerCase());
    case 'eq':
      return left === toComparable(node.value, raw);
    case 'ne':
      return left !== toComparable(node.value, raw);
    case 'lt':
      return left < toComparable(node.value, raw);
    case 'lte':
      return left <= toComparable(node.value, raw);
    case 'gt':
      return left > toComparable(node.value, raw);
    case 'gte':
      return left >= toComparable(node.value, raw);
  }
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Compile a filter to a boolean SQL expression over `alias` (a table alias in the query). Values
 * are always bound parameters; field names are validated identifiers.
 */
export function filterSql(alias: string, node: FilterNode): Expression<SqlBool> {
  if ('and' in node)
    return sql<SqlBool>`(${sql.join(
      node.and.map((n) => filterSql(alias, n)),
      sql` AND `,
    )})`;
  if ('or' in node)
    return sql<SqlBool>`(${sql.join(
      node.or.map((n) => filterSql(alias, n)),
      sql` OR `,
    )})`;
  if ('not' in node) return sql<SqlBool>`(NOT ${filterSql(alias, node.not)})`;
  const column = sql.ref(`${alias}.${node.field}`);
  switch (node.op) {
    case 'is_null':
      return sql<SqlBool>`${column} IS NULL`;
    case 'is_not_null':
      return sql<SqlBool>`${column} IS NOT NULL`;
    case 'in':
      return sql<SqlBool>`${column} IN (${sql.join(node.value.map((v) => sql.val(v)))})`;
    case 'not_in':
      return sql<SqlBool>`${column} NOT IN (${sql.join(node.value.map((v) => sql.val(v)))})`;
    case 'contains':
      return sql<SqlBool>`${column}::text ILIKE ${`%${escapeLike(node.value)}%`}`;
    case 'starts_with':
      return sql<SqlBool>`${column}::text ILIKE ${`${escapeLike(node.value)}%`}`;
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const operator = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' }[node.op];
      return sql<SqlBool>`${column} ${sql.raw(operator)} ${node.value}`;
    }
  }
}

/** `filterSql` for a Kysely `where` callback. */
export function compileFilter<DB, TB extends keyof DB & string>(
  _eb: ExpressionBuilder<DB, TB>,
  alias: string,
  node: FilterNode,
): Expression<SqlBool> {
  return filterSql(alias, node);
}
