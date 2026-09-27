import { sql, type Expression, type RawBuilder } from 'kysely';

import type { FormulaError, Span } from './ast.js';
import { dateIn } from './evaluate.js';
import { isNumeric, type FormulaType, type TypedNode } from './types.js';

type Sql = RawBuilder<unknown>;

/** How the compiler reaches data: columns of the record, globals and the clock. */
export interface SqlEnvironment {
  /**
   * A SQL expression for a field of the filtered record, typed as `type` (numeric, text, date,
   * timestamptz, time, boolean). Null when the field cannot be used in SQL (another object).
   */
  column(path: readonly string[], type: FormulaType): Expression<unknown> | null;
  global(scope: 'User' | 'Org', name: string): unknown;
  now: Date;
  timezone: string;
}

export type SqlResult = { ok: true; sql: Sql } | { ok: false; error: FormulaError };

class NotFilterable extends Error {
  constructor(readonly error: FormulaError) {
    super(error.code);
  }
}
const unsupported = (what: string, span: Span): never => {
  throw new NotFilterable({ code: 'not_filterable', params: { what }, span });
};

const PG_TYPE: Partial<Record<FormulaType, string>> = {
  Number: 'numeric',
  Currency: 'numeric',
  Percent: 'numeric',
  Text: 'text',
  Picklist: 'text',
  Boolean: 'boolean',
  Date: 'date',
  DateTime: 'timestamptz',
  Time: 'time',
};

/** A value as a typed bind parameter. */
function param(value: unknown, type: FormulaType): Sql {
  const pg = PG_TYPE[type];
  if (value === null || value === undefined || !pg) return sql`NULL`;
  return sql`${value}::${sql.raw(pg)}`;
}

const isTextual = (t: FormulaType) => t === 'Text' || t === 'Picklist';

/** "Is blank" as the evaluator defines it: null, or '' for text; a checkbox is never blank. */
function blank(node: TypedNode, e: Sql): Sql {
  if (node.type === 'Boolean') return sql`FALSE`;
  if (isTextual(node.type)) return sql`(NULLIF(${e}, '') IS NULL)`;
  return sql`(${e} IS NULL)`;
}

class Compiler {
  constructor(private readonly env: SqlEnvironment) {}

  compile(node: TypedNode): Sql {
    switch (node.kind) {
      case 'literal':
        return node.type === 'Null' ? sql`NULL` : param(node.value, node.type);
      case 'field': {
        if (node.type === 'MultiPicklist') unsupported('multi_picklist', node.span);
        const column = this.env.column(node.path, node.type);
        if (!column) return unsupported('field', node.span);
        return node.type === 'Boolean' ? sql`COALESCE(${column}, FALSE)` : sql`(${column})`;
      }
      case 'global':
        return param(this.env.global(node.scope, node.name), node.type);
      case 'unary': {
        const operand = this.compile(node.operand);
        return node.op === '!' ? sql`(NOT COALESCE(${operand}, FALSE))` : sql`(-${operand})`;
      }
      case 'binary':
        return this.binary(node);
      case 'call':
        return this.call(node);
    }
  }

  /** The evaluator's equality: two blanks are equal; a blank equals nothing else. */
  private equal(l: TypedNode, r: TypedNode, a: Sql, b: Sql): Sql {
    if (l.type === 'Null' && r.type === 'Null') return sql`TRUE`;
    if (l.type === 'Null') return blank(r, b);
    if (r.type === 'Null') return blank(l, a);
    return sql`(CASE WHEN ${blank(l, a)} OR ${blank(r, b)} THEN ${blank(l, a)} AND ${blank(r, b)} ELSE ${a} = ${b} END)`;
  }

  private binary(node: Extract<TypedNode, { kind: 'binary' }>): Sql {
    const a = this.compile(node.left);
    const b = this.compile(node.right);
    const { left: l, right: r } = node;
    switch (node.op) {
      case '&&':
        return sql`(COALESCE(${a}, FALSE) AND COALESCE(${b}, FALSE))`;
      case '||':
        return sql`(COALESCE(${a}, FALSE) OR COALESCE(${b}, FALSE))`;
      case '&':
        return sql`(COALESCE(${a}, '') || COALESCE(${b}, ''))`;
      case '=':
        return this.equal(l, r, a, b);
      case '!=':
        return sql`(NOT ${this.equal(l, r, a, b)})`;
      case '<':
      case '<=':
      case '>':
      case '>=':
        // Ordering with a blank is false; text orders by code point (as in the evaluator).
        return isTextual(l.type) || isTextual(r.type)
          ? sql`COALESCE(${a} COLLATE "C" ${sql.raw(node.op)} ${b} COLLATE "C", FALSE)`
          : sql`COALESCE(${a} ${sql.raw(node.op)} ${b}, FALSE)`;
      default:
        return this.arithmetic(node, a, b);
    }
  }

  private arithmetic(node: Extract<TypedNode, { kind: 'binary' }>, a: Sql, b: Sql): Sql {
    const { left: l, right: r, op } = node;
    if (node.type === 'Text') return sql`(COALESCE(${a}, '') || COALESCE(${b}, ''))`;
    // A blank operand makes the result blank.
    if (l.type === 'Null' || r.type === 'Null')
      return sql`NULL::${sql.raw(PG_TYPE[node.type] ?? 'text')}`;
    if (isNumeric(l.type) && isNumeric(r.type)) {
      if (op === '/') return sql`(${a} / NULLIF(${b}, 0))`;
      if (op === '^') return sql`power(${a}, ${b})`;
      return sql`(${a} ${sql.raw(op)} ${b})`;
    }
    const dateSide = l.type === 'Date' || l.type === 'DateTime' ? l : r;
    const days = dateSide === l ? b : a;
    const date = dateSide === l ? a : b;
    if (isNumeric(l.type) || isNumeric(r.type)) {
      const signed = op === '-' ? sql`(-${days})` : days;
      return dateSide.type === 'Date'
        ? sql`(${date} + floor(${signed})::int)`
        : sql`(${date} + ${signed} * interval '1 day')`;
    }
    if (l.type === 'Date' && r.type === 'Date') return sql`((${a} - ${b})::numeric)`;
    return sql`(extract(epoch from (${a} - ${b})) / 86400)`;
  }

  private call(node: Extract<TypedNode, { kind: 'call' }>): Sql {
    const args = node.args;
    const c = (i: number) => this.compile(args[i] as TypedNode);
    const all = () => args.map((a) => this.compile(a));
    const text = (i: number) => sql`COALESCE(${c(i)}, '')`;
    switch (node.name) {
      case 'IF':
        return sql`(CASE WHEN COALESCE(${c(0)}, FALSE) THEN ${c(1)} ELSE ${c(2)} END)`;
      case 'CASE': {
        const subject = args[0] as TypedNode;
        const s = c(0);
        const whens = [];
        for (let i = 1; i < args.length - 1; i += 2)
          whens.push(
            sql`WHEN ${this.equal(subject, args[i] as TypedNode, s, c(i))} THEN ${c(i + 1)}`,
          );
        return sql`(CASE ${sql.join(whens, sql` `)} ELSE ${c(args.length - 1)} END)`;
      }
      case 'AND':
        return sql`(${sql.join(
          all().map((e) => sql`COALESCE(${e}, FALSE)`),
          sql` AND `,
        )})`;
      case 'OR':
        return sql`(${sql.join(
          all().map((e) => sql`COALESCE(${e}, FALSE)`),
          sql` OR `,
        )})`;
      case 'NOT':
        return sql`(NOT COALESCE(${c(0)}, FALSE))`;
      case 'ISBLANK':
        return blank(args[0] as TypedNode, c(0));
      case 'BLANKVALUE': {
        const first = args[0] as TypedNode;
        return isTextual(first.type)
          ? sql`COALESCE(NULLIF(${c(0)}, ''), ${c(1)})`
          : sql`COALESCE(${c(0)}, ${c(1)})`;
      }
      case 'ISPICKVAL':
        return sql`COALESCE(${c(0)} = ${c(1)}, FALSE)`;
      case 'TEXT':
        return this.text(args[0] as TypedNode, c(0));
      case 'LEN':
        return sql`char_length(${text(0)})::numeric`;
      case 'LEFT':
        return sql`(CASE WHEN ${c(1)} IS NULL THEN NULL ELSE left(${text(0)}, greatest(floor(${c(1)})::int, 0)) END)`;
      case 'RIGHT':
        return sql`(CASE WHEN ${c(1)} IS NULL THEN NULL ELSE right(${text(0)}, greatest(floor(${c(1)})::int, 0)) END)`;
      case 'MID':
        return sql`(CASE WHEN ${c(1)} IS NULL OR ${c(2)} IS NULL THEN NULL ELSE substr(${text(0)}, greatest(floor(${c(1)})::int, 1), greatest(floor(${c(2)})::int, 0)) END)`;
      case 'CONTAINS':
        return sql`(strpos(${text(0)}, ${text(1)}) > 0)`;
      case 'BEGINS':
        return sql`starts_with(${text(0)}, ${text(1)})`;
      case 'UPPER':
        return sql`upper(${c(0)})`;
      case 'LOWER':
        return sql`lower(${c(0)})`;
      case 'TRIM':
        return sql`btrim(${c(0)}, E' \\t\\n\\r')`;
      case 'SUBSTITUTE':
        return sql`(CASE WHEN ${text(1)} = '' THEN ${c(0)} ELSE replace(${c(0)}, ${c(1)}, ${text(2)}) END)`;
      case 'ROUND':
        return sql`round(${c(0)}, floor(${c(1)})::int)`;
      case 'FLOOR':
        return sql`floor(${c(0)})`;
      case 'CEILING':
        return sql`ceil(${c(0)})`;
      case 'ABS':
        return sql`abs(${c(0)})`;
      case 'MIN':
      case 'MAX': {
        const values = all();
        const anyNull = sql.join(
          values.map((v) => sql`${v} IS NULL`),
          sql` OR `,
        );
        const fn = sql.raw(node.name === 'MIN' ? 'LEAST' : 'GREATEST');
        return sql`(CASE WHEN ${anyNull} THEN NULL ELSE ${fn}(${sql.join(values)}) END)`;
      }
      case 'MOD':
        return sql`mod(${c(0)}, NULLIF(${c(1)}, 0))`;
      case 'TODAY':
        return param(dateIn(this.env.now, this.env.timezone), 'Date');
      case 'NOW':
        return param(this.env.now.toISOString(), 'DateTime');
      case 'DATE':
        return sql`make_date(${c(0)}::int, ${c(1)}::int, ${c(2)}::int)`;
      case 'DATEVALUE': {
        const t = (args[0] as TypedNode).type;
        if (t === 'Date') return c(0);
        if (t === 'DateTime') return sql`((${c(0)}) AT TIME ZONE 'UTC')::date`;
        return sql`(substr(btrim(${c(0)}), 1, 10))::date`;
      }
      case 'YEAR':
      case 'MONTH':
      case 'DAY':
        return sql`extract(${sql.raw(node.name.toLowerCase())} from ${c(0)})::numeric`;
      case 'WEEKDAY':
        return sql`(extract(dow from ${c(0)}) + 1)::numeric`;
      case 'ADDMONTHS': {
        if ((args[0] as TypedNode).type !== 'Date') return unsupported('ADDMONTHS', node.span);
        const d = c(0);
        const months = sql`make_interval(months => trunc(${c(1)})::int)`;
        const monthEnd = (x: Sql) =>
          sql`(date_trunc('month', ${x}) + interval '1 month - 1 day')::date`;
        return sql`(CASE WHEN ${d} = ${monthEnd(d)} THEN ${monthEnd(sql`(${d} + ${months})`)} ELSE (${d} + ${months})::date END)`;
      }
      case 'DATEDIFF': {
        const ts = (i: number) =>
          (args[i] as TypedNode).type === 'Date'
            ? sql`((${c(i)})::timestamp AT TIME ZONE 'UTC')`
            : c(i);
        return sql`trunc(extract(epoch from (${ts(1)} - ${ts(0)})) / 86400)`;
      }
      default:
        // ISCHANGED, PRIORVALUE, ISNEW (no pending write in a query), REGEX (unbounded cost in
        // the database), VALUE (errors), INCLUDES (multi-selects), BUSINESSDAYS.
        return unsupported(node.name, node.span);
    }
  }

  private text(node: TypedNode, e: Sql): Sql {
    switch (node.type) {
      case 'Number':
      case 'Currency':
      case 'Percent':
        return sql`trim_scale(${e})::text`;
      case 'Date':
        return sql`to_char(${e}, 'YYYY-MM-DD')`;
      case 'DateTime':
        return sql`(to_char((${e}) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') || 'Z')`;
      case 'Time':
        return sql`to_char(${e}, 'HH24:MI:SS')`;
      case 'Boolean':
        return sql`(CASE WHEN COALESCE(${e}, FALSE) THEN 'true' ELSE 'false' END)`;
      default:
        return e;
    }
  }
}

/**
 * Compile a type-checked formula to a SQL expression with the evaluator's semantics, for use in
 * filters (§5.5). Functions that need a pending write, unbounded regexes, multi-selects and
 * cross-object fields are refused with `not_filterable`. Where the evaluator raises a runtime
 * error (division by zero), the SQL yields NULL, so the row simply does not match.
 */
export function compileToSql(ast: TypedNode, env: SqlEnvironment): SqlResult {
  try {
    return { ok: true, sql: new Compiler(env).compile(ast) };
  } catch (err) {
    if (err instanceof NotFilterable) return { ok: false, error: err.error };
    throw err;
  }
}
