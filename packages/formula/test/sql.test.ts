import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  checkFormula,
  compileToSql,
  Decimal,
  evaluateFormula,
  parse,
  FormulaSyntaxError,
  type CheckEnvironment,
  type FormulaType,
  type FormulaValue,
  type SqlEnvironment,
} from '../src/index.js';

/**
 * The SQL compiler must agree with the evaluator: every formula below is evaluated in TypeScript
 * and in Postgres over the same rows, and the results compared. A generator then does the same
 * for random well-typed formulas.
 */
const COLUMNS: Record<string, FormulaType> = {
  amount: 'Currency',
  discount: 'Percent',
  employees: 'Number',
  name: 'Text',
  email: 'Text',
  note: 'Text',
  is_active: 'Boolean',
  close_date: 'Date',
  created_at: 'DateTime',
  start_time: 'Time',
  stage: 'Picklist',
};
const PG: Record<FormulaType, string> = {
  Currency: 'numeric(18,2)',
  Percent: 'numeric(18,2)',
  Number: 'numeric(18,0)',
  Text: 'text',
  Picklist: 'text',
  Boolean: 'boolean',
  Date: 'date',
  DateTime: 'timestamptz',
  Time: 'time',
  MultiPicklist: 'text[]',
  Null: 'text',
};
type Row = Record<string, unknown>;
const ROWS: Row[] = [
  {
    amount: '1250.50',
    discount: '12.50',
    employees: '42',
    name: 'Maya Chen',
    email: 'maya@pixelcraft.example',
    note: '  hello  ',
    is_active: true,
    close_date: '2026-10-31',
    created_at: '2026-09-27T08:30:00.000Z',
    start_time: '09:30:00',
    stage: 'proposal',
  },
  {
    amount: null,
    discount: null,
    employees: null,
    name: null,
    email: null,
    note: null,
    is_active: null,
    close_date: null,
    created_at: null,
    start_time: null,
    stage: null,
  },
  {
    amount: '0.00',
    discount: '-5.25',
    employees: '0',
    name: '',
    email: '',
    note: '',
    is_active: false,
    close_date: '2024-02-29',
    created_at: '2024-02-29T23:59:59.000Z',
    start_time: '00:00:00',
    stage: '',
  },
  {
    amount: '-99.99',
    discount: '100.00',
    employees: '-7',
    name: 'Ångström Ω',
    email: 'x@y.example',
    note: 'a,b;c',
    is_active: true,
    close_date: '2026-01-31',
    created_at: '2026-01-31T12:00:00.000Z',
    start_time: '23:59:59',
    stage: 'closed_won',
  },
];
const NOW = new Date('2026-09-27T22:30:00.000Z');
const TZ = 'Asia/Qatar';

const env: CheckEnvironment = {
  allowPriorValues: false,
  field: (path) => {
    const type = COLUMNS[path.join('.')];
    return type ? { type } : { error: 'unknown_field' };
  },
  global: (_s, name) => (name === 'email' ? { type: 'Text' } : null),
};
const sqlEnv: SqlEnvironment = {
  column: (path, type) =>
    COLUMNS[path.join('.')] === type ? sql.ref(`r.${path.join('.')}`) : null,
  global: (_s, name) => (name === 'email' ? 'omar@pixelcraft.example' : null),
  now: NOW,
  timezone: TZ,
};

let admin: pg.Client;
let db: Kysely<Record<string, never>>;
const dbName = `sm_formula_${String(process.pid)}`;

beforeAll(async () => {
  const url = inject('pgServerAdminUrl');
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const target = new URL(url);
  target.pathname = `/${dbName}`;
  // Raw strings for numerics, dates and timestamps: the comparison parses them itself.
  const types = {
    getTypeParser: (oid: number): ((v: string) => unknown) =>
      [1700, 1082, 1083, 1114, 1184, 20].includes(oid)
        ? (v: string) => v
        : (pg.types.getTypeParser(oid) as (v: string) => unknown),
  };
  db = new Kysely({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: target.toString(), max: 2, types }),
    }),
  });
  const cols = Object.entries(COLUMNS).map(([n, t]) => `${n} ${PG[t]}`);
  await sql.raw(`CREATE TABLE rec (id int PRIMARY KEY, ${cols.join(', ')})`).execute(db);
  for (const [i, row] of ROWS.entries()) {
    const names = Object.keys(COLUMNS);
    await sql`INSERT INTO rec (id, ${sql.join(names.map((n) => sql.ref(n)))}) VALUES (${i}, ${sql.join(
      names.map((n) => row[n] ?? null),
    )})`.execute(db);
  }
});

afterAll(async () => {
  await db.destroy();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
});

/** Compare an evaluator value with what Postgres returned, by type. */
function same(type: FormulaType, value: FormulaValue, raw: unknown): boolean {
  if (value === null || raw === null) {
    // The evaluator's blank text may be '' where SQL keeps '', and vice versa.
    const blank = (v: unknown) => v === null || v === '';
    return type === 'Text' || type === 'Picklist'
      ? blank(value) && blank(raw)
      : value === null && raw === null;
  }
  switch (type) {
    case 'Number':
    case 'Currency':
    case 'Percent':
      // Postgres division keeps ~16 decimals; the evaluator 34 significant digits.
      return new Decimal(raw as string)
        .toDecimalPlaces(12)
        .eq((value as Decimal).toDecimalPlaces(12));
    case 'DateTime':
      return new Date(raw as string).getTime() === (value as Date).getTime();
    case 'Date':
      return typeof raw === 'string' && raw.slice(0, 10) === value;
    default:
      return raw === value;
  }
}

async function agree(source: string): Promise<{ checked: number }> {
  const checked = checkFormula(source, env);
  if (!checked.ok) throw new Error(`${source}: ${checked.error.code}`);
  const compiled = compileToSql(checked.ast, sqlEnv);
  if (!compiled.ok)
    throw new Error(`${source}: ${compiled.error.code} ${JSON.stringify(compiled.error.params)}`);
  const rows = await sql<{
    id: number;
    v: unknown;
  }>`SELECT r.id, ${compiled.sql} AS v FROM rec r ORDER BY r.id`.execute(db);
  let count = 0;
  for (const [i, row] of ROWS.entries()) {
    const result = evaluateFormula(checked.ast, {
      field: (p) => row[p.join('.')],
      global: (_s, name) => (name === 'email' ? 'omar@pixelcraft.example' : null),
      now: NOW,
      timezone: TZ,
    });
    if (!result.ok) continue; // runtime errors: SQL yields NULL or raises; not compared
    const raw = rows.rows[i]?.v ?? null;
    if (!same(checked.type, result.value, raw))
      throw new Error(
        `${source} row ${String(i)}: evaluator ${String(result.value)} ≠ sql ${JSON.stringify(raw)}`,
      );
    count += 1;
  }
  return { checked: count };
}

describe('compileToSql agrees with the evaluator', () => {
  it.each([
    'amount',
    'employees',
    'name',
    'is_active',
    'close_date',
    'created_at',
    'stage',
    "'lit'",
    '1.25',
    'null',
    'amount * 2',
    'amount + employees',
    'amount - discount',
    'amount / 4',
    'amount / employees',
    'employees ^ 2',
    '-amount',
    "name & '!' & email",
    "name + '?'",
    'note & null',
    'amount > 100',
    'amount >= 1250.5',
    'amount = 0',
    'amount != 0',
    'employees < 0',
    "name = 'Maya Chen'",
    "name < 'N'",
    "name = ''",
    'name = null',
    'name != null',
    'amount = null',
    'null = null',
    'close_date = close_date',
    'close_date > DATE(2025, 1, 1)',
    'created_at < NOW()',
    'is_active && amount > 0',
    'is_active || employees > 0',
    '!is_active',
    'is_active = true',
    "IF(is_active, 'yes', 'no')",
    'IF(amount > 1000, amount, 0)',
    'IF(is_active, name, null)',
    "CASE(stage, 'proposal', 1, 'closed_won', 2, 0)",
    "CASE(employees, 42, 'a', 0, 'b', 'c')",
    "CASE(name, '', 'empty', 'Maya Chen', 'maya', 'other')",
    'AND(is_active, amount > 0)',
    'OR(is_active, employees = 0)',
    'NOT(is_active)',
    'ISBLANK(name)',
    'ISBLANK(amount)',
    'ISBLANK(is_active)',
    'ISBLANK(close_date)',
    'ISBLANK(stage)',
    "BLANKVALUE(name, 'n/a')",
    'BLANKVALUE(amount, 0)',
    "ISPICKVAL(stage, 'proposal')",
    'TEXT(amount)',
    'TEXT(employees)',
    'TEXT(close_date)',
    'TEXT(created_at)',
    'TEXT(is_active)',
    'TEXT(start_time)',
    'TEXT(stage)',
    'LEN(name)',
    'LEN(note)',
    'LEFT(name, 4)',
    'LEFT(name, employees)',
    'RIGHT(name, 3)',
    'RIGHT(name, -1)',
    'MID(name, 2, 3)',
    'MID(name, 0, 2)',
    "CONTAINS(email, '@')",
    "CONTAINS(name, '')",
    "BEGINS(name, 'Ma')",
    'UPPER(name)',
    'LOWER(name)',
    'TRIM(note)',
    "SUBSTITUTE(note, 'l', 'L')",
    "SUBSTITUTE(name, '', 'x')",
    'ROUND(amount, 0)',
    'ROUND(amount, -2)',
    'ROUND(discount, 1)',
    'FLOOR(discount)',
    'CEILING(discount)',
    'ABS(discount)',
    'MIN(amount, employees)',
    'MAX(amount, employees, 1)',
    'MOD(employees, 5)',
    'MOD(employees, 0)',
    'amount / 0',
    'TODAY()',
    'NOW()',
    'DATE(2026, 2, 28)',
    "DATEVALUE('2026-09-27')",
    'DATEVALUE(created_at)',
    'DATEVALUE(close_date)',
    'YEAR(close_date)',
    'MONTH(close_date)',
    'DAY(close_date)',
    'WEEKDAY(close_date)',
    'close_date + 1',
    'close_date - 1.5',
    '7 + close_date',
    'close_date - DATE(2026, 1, 1)',
    'created_at + 0.25',
    'created_at - 1',
    'NOW() - created_at',
    'close_date + null',
    'ADDMONTHS(close_date, 1)',
    'ADDMONTHS(close_date, -13)',
    'ADDMONTHS(close_date, 1.9)',
    'DATEDIFF(close_date, TODAY())',
    'DATEDIFF(created_at, NOW())',
    'DATEDIFF(close_date, created_at)',
    'close_date >= TODAY() - 30',
    '$User.email',
    "$User.email = 'omar@pixelcraft.example'",
  ])('%s', async (source) => {
    await agree(source);
  });

  it('refuses what cannot run in a query', () => {
    const check = (source: string, allowPrior = false) => {
      const c = checkFormula(source, { ...env, allowPriorValues: allowPrior });
      if (!c.ok) throw new Error(c.error.code);
      return compileToSql(c.ast, sqlEnv);
    };
    for (const source of [
      "REGEX(name, 'a')",
      "VALUE('1')",
      'BUSINESSDAYS(close_date, TODAY())',
      'ADDMONTHS(created_at, 1)',
    ])
      expect(check(source)).toMatchObject({ ok: false, error: { code: 'not_filterable' } });
    for (const source of ['ISNEW()', 'ISCHANGED(amount)', 'PRIORVALUE(amount) > 0'])
      expect(check(source, true)).toMatchObject({ ok: false, error: { code: 'not_filterable' } });
    const other: SqlEnvironment = { ...sqlEnv, column: () => null };
    const c = checkFormula('amount > 0', env);
    if (!c.ok) throw new Error('check');
    expect(compileToSql(c.ast, other)).toMatchObject({
      ok: false,
      error: { params: { what: 'field' } },
    });
    const multi = checkFormula('ISBLANK(tags)', {
      ...env,
      field: (p) => (p[0] === 'tags' ? { type: 'MultiPicklist' } : { error: 'unknown_field' }),
    });
    if (!multi.ok) throw new Error('check');
    expect(compileToSql(multi.ast, sqlEnv)).toMatchObject({ ok: false });
  });
});

/** Seeded PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random well-typed formulas over the columns. */
function generator(seed: number) {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const gen = {
    num: (d: number): string =>
      d <= 0
        ? pick([
            'amount',
            'employees',
            'discount',
            String(Math.floor(r() * 200) - 50),
            `${String(Math.floor(r() * 100))}.5`,
          ])
        : pick([
            () => `(${gen.num(d - 1)} ${pick(['+', '-', '*'])} ${gen.num(d - 1)})`,
            () => `ROUND(${gen.num(d - 1)}, ${String(Math.floor(r() * 3))})`,
            () => `ABS(${gen.num(d - 1)})`,
            () => `IF(${gen.bool(d - 1)}, ${gen.num(d - 1)}, ${gen.num(d - 1)})`,
            () => `LEN(${gen.text(d - 1)})`,
            () => `MAX(${gen.num(d - 1)}, ${gen.num(d - 1)})`,
            () => `BLANKVALUE(${gen.num(d - 1)}, 0)`,
            () => `DAY(${gen.date(d - 1)})`,
          ])(),
    text: (d: number): string =>
      d <= 0
        ? pick(['name', 'email', 'note', "'x'", "''", "'Maya'"])
        : pick([
            () => `(${gen.text(d - 1)} & ${gen.text(d - 1)})`,
            () => `UPPER(${gen.text(d - 1)})`,
            () => `LEFT(${gen.text(d - 1)}, ${String(Math.floor(r() * 5))})`,
            () => `TRIM(${gen.text(d - 1)})`,
            () => `IF(${gen.bool(d - 1)}, ${gen.text(d - 1)}, ${gen.text(d - 1)})`,
            () => `TEXT(${gen.num(d - 1)})`,
            () => `SUBSTITUTE(${gen.text(d - 1)}, 'a', 'b')`,
          ])(),
    bool: (d: number): string =>
      d <= 0
        ? pick(['is_active', 'true', 'false', "ISPICKVAL(stage, 'proposal')"])
        : pick([
            () =>
              `(${gen.num(d - 1)} ${pick(['<', '<=', '>', '>=', '=', '!='])} ${gen.num(d - 1)})`,
            () => `(${gen.text(d - 1)} ${pick(['=', '!=', '<'])} ${gen.text(d - 1)})`,
            () => `(${gen.bool(d - 1)} ${pick(['&&', '||'])} ${gen.bool(d - 1)})`,
            () => `NOT(${gen.bool(d - 1)})`,
            () => `ISBLANK(${pick([gen.text, gen.num])(d - 1)})`,
            () => `CONTAINS(${gen.text(d - 1)}, ${gen.text(0)})`,
            () => `(${gen.date(d - 1)} > ${gen.date(d - 1)})`,
          ])(),
    date: (d: number): string =>
      d <= 0
        ? pick(['close_date', 'TODAY()', 'DATE(2026, 3, 31)'])
        : pick([
            () => `(${gen.date(d - 1)} + ${String(Math.floor(r() * 60) - 30)})`,
            () => `ADDMONTHS(${gen.date(d - 1)}, ${String(Math.floor(r() * 24) - 12)})`,
            () => `IF(${gen.bool(d - 1)}, ${gen.date(d - 1)}, ${gen.date(d - 1)})`,
            () => `DATEVALUE(created_at)`,
          ])(),
  };
  return () => pick([gen.num, gen.text, gen.bool, gen.date])(1 + Math.floor(r() * 3));
}

describe('fuzz', () => {
  it('agrees on 300 random well-typed formulas', async () => {
    const next = generator(20260927);
    let rows = 0;
    for (let i = 0; i < 300; i += 1) rows += (await agree(next())).checked;
    expect(rows).toBeGreaterThan(900);
  });

  it('never fails on arbitrary input except with a syntax error', () => {
    const r = rng(42);
    const alphabet = 'abc_$.()\'",+-*/^&=<>!|  1234567890IFANDOR\\';
    for (let i = 0; i < 3000; i += 1) {
      const length = Math.floor(r() * 30);
      let source = '';
      for (let j = 0; j < length; j += 1)
        source += alphabet[Math.floor(r() * alphabet.length)] ?? '';
      try {
        parse(source);
        checkFormula(source, env);
      } catch (err) {
        expect(err).toBeInstanceOf(FormulaSyntaxError);
      }
    }
  });
});
