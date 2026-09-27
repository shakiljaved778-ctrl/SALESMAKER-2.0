import { Decimal as BaseDecimal } from 'decimal.js';

import type { FormulaError, Span } from './ast.js';
import type { FormulaType, TypedNode } from './types.js';

/** Arithmetic in 34 significant digits, rounding half away from zero (§0.4 rule 8). */
export const Decimal = BaseDecimal.clone({ precision: 34, rounding: BaseDecimal.ROUND_HALF_UP });
export type Decimal = BaseDecimal;

/**
 * Runtime values: numbers are Decimals; Date `YYYY-MM-DD`; DateTime a JS Date (UTC instant);
 * Time `HH:MM:SS`; picklists their API value; multi-selects string arrays; blanks are null.
 */
export type FormulaValue = string | boolean | Decimal | Date | string[] | null;

/** What a formula reads while it runs. Field values arrive as stored (see `normaliseValue`). */
export interface EvalContext {
  field(path: readonly string[]): unknown;
  /** The value before the pending write (validation rules, automation). */
  prior?(path: readonly string[]): unknown;
  isNew?: boolean;
  global(scope: 'User' | 'Org', name: string): unknown;
  /** The clock (tests pass a fixed one). */
  now: Date;
  /** IANA zone TODAY() is taken in (the user's, else the organisation's). */
  timezone: string;
}

export class FormulaRuntimeError extends Error {
  constructor(readonly error: FormulaError) {
    super(error.code);
  }
}

const fail = (code: string, span: Span, params: Record<string, string | number> = {}): never => {
  throw new FormulaRuntimeError({ code, params, span });
};

const DAY_MS = 86_400_000;
/** REGEX runs on at most this much text (the pattern is admin-authored; this bounds its cost). */
const MAX_REGEX_INPUT = 10_000;

/** Convert a stored value to the runtime representation of `type`. */
export function fromStored(type: FormulaType, raw: unknown): FormulaValue {
  if (raw === undefined || raw === null) return type === 'Boolean' ? false : null;
  switch (type) {
    case 'Number':
    case 'Currency':
    case 'Percent':
      if (raw instanceof BaseDecimal) return new Decimal(raw);
      if (typeof raw === 'number' || typeof raw === 'string') {
        if (raw === '') return null;
        try {
          return new Decimal(raw);
        } catch {
          return null;
        }
      }
      return null;
    case 'Boolean':
      return raw === true;
    case 'Date':
      if (raw instanceof Date) return raw.toISOString().slice(0, 10);
      return typeof raw === 'string' ? raw.slice(0, 10) : null;
    case 'DateTime':
      if (raw instanceof Date) return raw;
      if (typeof raw === 'string') {
        const d = new Date(raw);
        return Number.isNaN(d.getTime()) ? null : d;
      }
      return null;
    case 'MultiPicklist':
      return Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(';') : null;
    default:
      if (typeof raw === 'string') return raw;
      return typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : null;
  }
}

const isBlank = (v: FormulaValue): boolean =>
  v === null || v === '' || (Array.isArray(v) && v.length === 0);
const dec = (v: FormulaValue): Decimal | null => (v instanceof BaseDecimal ? v : null);
const str = (v: FormulaValue): string => (typeof v === 'string' ? v : '');

function dateParts(d: string): [number, number, number] {
  return [Number(d.slice(0, 4)), Number(d.slice(5, 7)), Number(d.slice(8, 10))];
}
const toDate = (y: number, m: number, d: number): string =>
  new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const dateMs = (d: string): number => {
  const [y, m, day] = dateParts(d);
  return Date.UTC(y, m - 1, day);
};
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The calendar date of an instant in a time zone. */
export function dateIn(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** ADDMONTHS: Salesforce semantics, including "last day stays last day". */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = dateParts(date);
  const total = y * 12 + (m - 1) + months;
  const ty = Math.floor(total / 12);
  const tm = (total % 12) + 1;
  const last = daysInMonth(ty, tm);
  const day = d === daysInMonth(y, m) ? last : Math.min(d, last);
  return toDate(ty, tm, day);
}

function textOf(v: FormulaValue): string | null {
  if (v === null) return null;
  if (v instanceof BaseDecimal) return v.toString();
  if (v instanceof Date) return `${v.toISOString().slice(0, 19).replace('T', ' ')}Z`;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.join(';');
  return v;
}

function equal(a: FormulaValue, b: FormulaValue): boolean {
  if (isBlank(a) || isBlank(b)) return isBlank(a) && isBlank(b);
  const da = dec(a);
  const db = dec(b);
  if (da && db) return da.eq(db);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) return a.join(';') === b.join(';');
  return a === b;
}

function compare(a: FormulaValue, b: FormulaValue): number | null {
  if (a === null || b === null) return null;
  const da = dec(a);
  const db = dec(b);
  if (da && db) return da.cmp(db);
  if (a instanceof Date && b instanceof Date) return Math.sign(a.getTime() - b.getTime());
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

class Evaluator {
  constructor(private readonly ctx: EvalContext) {}

  run(node: TypedNode): FormulaValue {
    switch (node.kind) {
      case 'literal':
        if (node.value === null) return null;
        return node.type === 'Number' ? new Decimal(node.value as string) : node.value;
      case 'field':
        return fromStored(node.type, this.ctx.field(node.path));
      case 'global':
        return fromStored(node.type, this.ctx.global(node.scope, node.name));
      case 'unary': {
        const v = this.run(node.operand);
        if (node.op === '!') return v !== true;
        const d = dec(v);
        return d ? d.neg() : null;
      }
      case 'binary':
        return this.binary(node);
      case 'call':
        return this.call(node);
    }
  }

  private binary(node: Extract<TypedNode, { kind: 'binary' }>): FormulaValue {
    if (node.op === '&&') return this.run(node.left) === true && this.run(node.right) === true;
    if (node.op === '||') return this.run(node.left) === true || this.run(node.right) === true;
    const a = this.run(node.left);
    const b = this.run(node.right);
    switch (node.op) {
      case '&':
        return str(a) + str(b);
      case '=':
        return equal(a, b);
      case '!=':
        return !equal(a, b);
      case '<':
      case '<=':
      case '>':
      case '>=': {
        const c = compare(a, b);
        if (c === null) return false;
        return node.op === '<'
          ? c < 0
          : node.op === '<='
            ? c <= 0
            : node.op === '>'
              ? c > 0
              : c >= 0;
      }
      default:
        return this.arithmetic(node, a, b);
    }
  }

  private arithmetic(
    node: Extract<TypedNode, { kind: 'binary' }>,
    a: FormulaValue,
    b: FormulaValue,
  ): FormulaValue {
    if (node.type === 'Text') return str(a) + str(b); // Text + Text
    if (a === null || b === null) return null;
    const da = dec(a);
    const db = dec(b);
    if (da && db) {
      switch (node.op) {
        case '+':
          return da.plus(db);
        case '-':
          return da.minus(db);
        case '*':
          return da.times(db);
        case '/':
          return db.isZero() ? fail('division_by_zero', node.span) : da.div(db);
        default:
          return this.power(node, da, db);
      }
    }
    // Date and date-time arithmetic: numbers are days.
    const days = da ?? db;
    const other = da ? b : a;
    if (days && typeof other === 'string')
      return toDate(...shift(dateParts(other), node.op === '-' ? days.neg() : days));
    if (days && other instanceof Date)
      return new Date(
        other.getTime() + (node.op === '-' ? days.neg() : days).times(DAY_MS).toNumber(),
      );
    if (typeof a === 'string' && typeof b === 'string')
      return new Decimal((dateMs(a) - dateMs(b)) / DAY_MS);
    if (a instanceof Date && b instanceof Date)
      return new Decimal(a.getTime() - b.getTime()).div(DAY_MS);
    return null;
  }

  private power(node: TypedNode, base: Decimal, exponent: Decimal): Decimal {
    if (exponent.abs().gt(1000) || (base.isZero() && exponent.isNeg()))
      fail('invalid_power', node.span);
    const result = base.pow(exponent);
    return result.isFinite() ? result : fail('invalid_power', node.span);
  }

  private call(node: Extract<TypedNode, { kind: 'call' }>): FormulaValue {
    const args = node.args;
    const arg = (i: number) => this.run(args[i] as TypedNode);
    const num = (i: number) => dec(arg(i));
    switch (node.name) {
      case 'IF':
        return arg(0) === true ? arg(1) : arg(2);
      case 'CASE': {
        const subject = arg(0);
        for (let i = 1; i < args.length - 1; i += 2) if (equal(subject, arg(i))) return arg(i + 1);
        return arg(args.length - 1);
      }
      case 'AND':
        return args.every((a) => this.run(a) === true);
      case 'OR':
        return args.some((a) => this.run(a) === true);
      case 'NOT':
        return arg(0) !== true;
      case 'ISBLANK':
        return isBlank(arg(0));
      case 'BLANKVALUE': {
        const v = arg(0);
        return isBlank(v) ? arg(1) : v;
      }
      case 'ISNEW':
        return this.ctx.isNew === true;
      case 'ISCHANGED':
      case 'PRIORVALUE': {
        const field = args[0] as Extract<TypedNode, { kind: 'field' }>;
        const current = arg(0);
        const prior =
          this.ctx.isNew || !this.ctx.prior
            ? current
            : fromStored(field.type, this.ctx.prior(field.path));
        return node.name === 'PRIORVALUE' ? prior : !equal(current, prior);
      }
      case 'ISPICKVAL':
        return arg(0) === arg(1);
      case 'INCLUDES': {
        const values = arg(0);
        return Array.isArray(values) && values.includes(str(arg(1)));
      }
      case 'TEXT':
        return textOf(arg(0));
      case 'VALUE': {
        const t = arg(0);
        if (t === null) return null;
        const s = str(t).trim();
        return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)
          ? new Decimal(s)
          : fail('invalid_number', node.span);
      }
      case 'LEN':
        return new Decimal(Array.from(str(arg(0))).length);
      case 'LEFT': {
        const n = num(1);
        return n === null
          ? null
          : Array.from(str(arg(0)))
              .slice(0, Math.max(0, n.floor().toNumber()))
              .join('');
      }
      case 'RIGHT': {
        const n = num(1);
        if (n === null) return null;
        const chars = Array.from(str(arg(0)));
        const count = Math.max(0, n.floor().toNumber());
        return count === 0 ? '' : chars.slice(-count).join('');
      }
      case 'MID': {
        const start = num(1);
        const count = num(2);
        if (start === null || count === null) return null;
        const from = Math.max(1, start.floor().toNumber()) - 1;
        return Array.from(str(arg(0)))
          .slice(from, from + Math.max(0, count.floor().toNumber()))
          .join('');
      }
      case 'CONTAINS':
        return str(arg(0)).includes(str(arg(1)));
      case 'BEGINS':
        return str(arg(0)).startsWith(str(arg(1)));
      case 'UPPER': {
        const v = arg(0);
        return v === null ? null : str(v).toUpperCase();
      }
      case 'LOWER': {
        const v = arg(0);
        return v === null ? null : str(v).toLowerCase();
      }
      case 'TRIM': {
        const v = arg(0);
        return v === null ? null : str(v).trim();
      }
      case 'SUBSTITUTE': {
        const v = arg(0);
        if (v === null) return null;
        const find = str(arg(1));
        return find === ''
          ? str(v)
          : str(v)
              .split(find)
              .join(str(arg(2)));
      }
      case 'REGEX': {
        const text = str(arg(0));
        if (text.length > MAX_REGEX_INPUT)
          return fail('regex_input_too_long', node.span, { max: MAX_REGEX_INPUT });
        return new RegExp(`^(?:${str(arg(1))})$`, 'u').test(text);
      }
      case 'ROUND': {
        const n = num(0);
        const digits = num(1);
        if (n === null || digits === null) return null;
        const d = digits.floor().toNumber();
        if (d >= 0) return n.toDecimalPlaces(d, Decimal.ROUND_HALF_UP);
        const factor = new Decimal(10).pow(-d);
        return n.div(factor).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(factor);
      }
      case 'FLOOR':
        return num(0)?.floor() ?? null;
      case 'CEILING':
        return num(0)?.ceil() ?? null;
      case 'ABS':
        return num(0)?.abs() ?? null;
      case 'MIN':
      case 'MAX': {
        const values = args.map((_, i) => num(i));
        if (values.some((v) => v === null)) return null;
        const ds = values as Decimal[];
        return node.name === 'MIN' ? Decimal.min(...ds) : Decimal.max(...ds);
      }
      case 'MOD': {
        const a = num(0);
        const b = num(1);
        if (a === null || b === null) return null;
        return b.isZero() ? fail('division_by_zero', node.span) : a.mod(b);
      }
      case 'TODAY':
        return dateIn(this.ctx.now, this.ctx.timezone);
      case 'NOW':
        return new Date(this.ctx.now.getTime());
      case 'DATE': {
        const [y, m, d] = [num(0), num(1), num(2)];
        if (y === null || m === null || d === null) return null;
        const [yy, mm, dd] = [y.toNumber(), m.toNumber(), d.toNumber()];
        const ok =
          [yy, mm, dd].every(Number.isInteger) &&
          yy >= 1 &&
          yy <= 9999 &&
          mm >= 1 &&
          mm <= 12 &&
          dd >= 1 &&
          dd <= daysInMonth(yy, mm);
        return ok ? toDate(yy, mm, dd) : fail('invalid_date', node.span);
      }
      case 'DATEVALUE': {
        const v = arg(0);
        if (v === null) return null;
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        const s = str(v).trim();
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
        if (!m) return fail('invalid_date', node.span);
        const [yy, mm, dd] = [Number(m[1]), Number(m[2]), Number(m[3])];
        return mm >= 1 && mm <= 12 && dd >= 1 && dd <= daysInMonth(yy, mm)
          ? toDate(yy, mm, dd)
          : fail('invalid_date', node.span);
      }
      case 'YEAR':
      case 'MONTH':
      case 'DAY':
      case 'WEEKDAY': {
        const v = arg(0);
        if (typeof v !== 'string') return null;
        const [y, m, d] = dateParts(v);
        if (node.name === 'WEEKDAY')
          return new Decimal(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 1);
        return new Decimal(node.name === 'YEAR' ? y : node.name === 'MONTH' ? m : d);
      }
      case 'ADDMONTHS': {
        const v = arg(0);
        const n = num(1);
        if (v === null || n === null) return null;
        const months = n.trunc().toNumber();
        if (v instanceof Date) {
          const date = addMonths(v.toISOString().slice(0, 10), months);
          return new Date(`${date}T${v.toISOString().slice(11)}`);
        }
        return addMonths(str(v), months);
      }
      case 'DATEDIFF': {
        const a = arg(0);
        const b = arg(1);
        if (a === null || b === null) return null;
        const ms = (v: FormulaValue) => (v instanceof Date ? v.getTime() : dateMs(str(v)));
        return new Decimal(Math.trunc((ms(b) - ms(a)) / DAY_MS));
      }
      case 'BUSINESSDAYS': {
        const a = arg(0);
        const b = arg(1);
        if (typeof a !== 'string' || typeof b !== 'string') return null;
        return new Decimal(businessDays(a, b));
      }
      default:
        return fail('unknown_function', node.span, { name: node.name });
    }
  }
}

function shift([y, m, d]: [number, number, number], days: Decimal): [number, number, number] {
  const ms = Date.UTC(y, m - 1, d) + days.floor().toNumber() * DAY_MS;
  const t = new Date(ms);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

/** Monday–Friday days from `start` (inclusive) to `end` (exclusive); negative when reversed. */
export function businessDays(start: string, end: string): number {
  const a = dateMs(start);
  const b = dateMs(end);
  const sign = b >= a ? 1 : -1;
  const [from, to] = sign === 1 ? [a, b] : [b, a];
  const days = Math.round((to - from) / DAY_MS);
  const weeks = Math.floor(days / 7);
  let count = weeks * 5;
  const startDay = new Date(from).getUTCDay();
  for (let i = 0; i < days % 7; i += 1) {
    const wd = (startDay + i) % 7;
    if (wd !== 0 && wd !== 6) count += 1;
  }
  return sign * count;
}

export type EvalResult = { ok: true; value: FormulaValue } | { ok: false; error: FormulaError };

/** Run a type-checked formula. Runtime problems (division by zero, bad dates) come back as errors. */
export function evaluateFormula(ast: TypedNode, ctx: EvalContext): EvalResult {
  try {
    return { ok: true, value: new Evaluator(ctx).run(ast) };
  } catch (err) {
    if (err instanceof FormulaRuntimeError) return { ok: false, error: err.error };
    throw err;
  }
}

/** A runtime value as it would be stored (decimal strings, ISO dates) — the inverse of fromStored. */
export function toStored(value: FormulaValue): unknown {
  if (value === null) return null;
  if (value instanceof BaseDecimal) return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}
