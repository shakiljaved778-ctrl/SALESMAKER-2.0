import { describe, expect, it } from 'vitest';

import {
  addMonths,
  businessDays,
  checkFormula,
  dateIn,
  Decimal,
  evaluateFormula,
  fromStored,
  toStored,
  type CheckEnvironment,
  type FormulaType,
  type FormulaValue,
} from '../src/index.js';

const TYPES: Record<string, FormulaType> = {
  amount: 'Currency',
  discount: 'Percent',
  employees: 'Number',
  name: 'Text',
  email: 'Text',
  blank_text: 'Text',
  blank_number: 'Number',
  is_active: 'Boolean',
  blank_flag: 'Boolean',
  close_date: 'Date',
  blank_date: 'Date',
  created_at: 'DateTime',
  start_time: 'Time',
  stage: 'Picklist',
  tags: 'MultiPicklist',
  'account.name': 'Text',
};
const RECORD: Record<string, unknown> = {
  amount: '1250.50',
  discount: '12.5',
  employees: 42,
  name: 'Maya Chen',
  email: 'maya@pixelcraft.example',
  blank_text: null,
  blank_number: null,
  is_active: true,
  blank_flag: null,
  close_date: '2026-10-31',
  blank_date: null,
  created_at: '2026-09-27T08:30:00.000Z',
  start_time: '09:30:00',
  stage: 'proposal',
  tags: ['vip', 'renewal'],
  'account.name': 'Pixelcraft Studio',
};
const PRIOR: Record<string, unknown> = { ...RECORD, amount: '1000.00', stage: 'discovery' };
const NOW = new Date('2026-09-27T22:30:00.000Z'); // already the 28th in Doha

const env: CheckEnvironment = {
  allowPriorValues: true,
  field: (path) => {
    const type = TYPES[path.join('.')];
    return type ? { type } : { error: 'unknown_field' };
  },
  global: (_scope, name) => (name === 'email' || name === 'name' ? { type: 'Text' } : null),
};

function show(v: FormulaValue): string {
  if (v === null) return 'null';
  if (v instanceof Decimal) return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return `[${v.join(',')}]`;
  return String(v);
}

function run(source: string, options: { isNew?: boolean; timezone?: string } = {}): string {
  const checked = checkFormula(source, env);
  if (!checked.ok) throw new Error(`${source}: ${checked.error.code}`);
  const result = evaluateFormula(checked.ast, {
    field: (p) => RECORD[p.join('.')],
    prior: (p) => PRIOR[p.join('.')],
    isNew: options.isNew ?? false,
    global: (scope, name) =>
      scope === 'User' && name === 'email' ? 'omar@pixelcraft.example' : null,
    now: NOW,
    timezone: options.timezone ?? 'UTC',
  });
  if (!result.ok) return `error:${result.error.code}`;
  return show(result.value);
}

describe('evaluateFormula', () => {
  it.each([
    // literals and fields
    ['1', '1'],
    ['1.50', '1.5'],
    ["'hi'", 'hi'],
    ['true', 'true'],
    ['null', 'null'],
    ['amount', '1250.5'],
    ['employees', '42'],
    ['is_active', 'true'],
    ['blank_flag', 'false'],
    ['close_date', '2026-10-31'],
    ['created_at', '2026-09-27T08:30:00.000Z'],
    ['start_time', '09:30:00'],
    ['stage', 'proposal'],
    ['tags', '[vip,renewal]'],
    ['account.name', 'Pixelcraft Studio'],
    ['$User.email', 'omar@pixelcraft.example'],
    ['$User.name', 'null'],
    // arithmetic in decimals, never floats
    ['0.1 + 0.2', '0.3'],
    ['amount * 2', '2501'],
    ['amount - 250.5', '1000'],
    ['amount / 4', '312.625'],
    ['10 / 4', '2.5'],
    // 34 significant digits: values are rounded to the field's scale when stored.
    ['1 / 3 * 3', '0.9999999999999999999999999999999999'],
    ['ROUND(1 / 3 * 3, 2)', '1'],
    ['2 ^ 10', '1024'],
    ['2 ^ -1', '0.5'],
    ['-amount', '-1250.5'],
    ['--employees', '42'],
    ['employees + blank_number', 'null'],
    ['blank_number * 2', 'null'],
    ['-blank_number', 'null'],
    ['1 / 0', 'error:division_by_zero'],
    ['0 ^ -1', 'error:invalid_power'],
    ['2 ^ 5000', 'error:invalid_power'],
    // text
    ["name & ' <' & email & '>'", 'Maya Chen <maya@pixelcraft.example>'],
    ["name + '!'", 'Maya Chen!'],
    ["blank_text & 'x'", 'x'],
    ["'a' + blank_text", 'a'],
    // comparison and null semantics
    ['amount > 1000', 'true'],
    ['amount >= 1250.50', 'true'],
    ['amount < employees', 'false'],
    ['amount = 1250.5', 'true'],
    ['employees = 42.0', 'true'],
    ['employees != 42', 'false'],
    ["name = 'Maya Chen'", 'true'],
    ["name = 'maya chen'", 'false'],
    ["name < 'Zed'", 'true'],
    ['blank_text = null', 'true'],
    ["blank_text = ''", 'true'],
    ['name != null', 'true'],
    ['blank_number > 0', 'false'],
    ['blank_number <= 0', 'false'],
    ['null = null', 'true'],
    ['close_date > DATE(2026, 1, 1)', 'true'],
    ['created_at < NOW()', 'true'],
    ["TEXT(start_time) > '09:00:00'", 'true'],
    ['is_active = true', 'true'],
    // boolean logic (blank is false)
    ['is_active && blank_flag', 'false'],
    ['is_active || blank_flag', 'true'],
    ['!blank_flag', 'true'],
    ['AND(is_active, amount > 0, employees > 40)', 'true'],
    ['AND(is_active, 1 / 0 > 0, false)', 'error:division_by_zero'],
    ['OR(false, blank_flag, is_active)', 'true'],
    ['NOT(is_active)', 'false'],
    ['false && 1 / 0 > 0', 'false'],
    ['true || 1 / 0 > 0', 'true'],
    // IF / CASE / blanks
    ["IF(is_active, 'yes', 1 / 0 > 0)", 'error:branch'],
    ["IF(amount > 1000, 'big', 'small')", 'big'],
    ["IF(blank_flag, 'y', 'n')", 'n'],
    ['IF(is_active, amount, 0)', '1250.5'],
    ["CASE(stage, 'discovery', 1, 'proposal', 2, 0)", '2'],
    ["CASE(stage, 'won', 'W', 'lost', 'L', '-')", '-'],
    ["CASE(employees, 41, 'a', 42, 'b', 'c')", 'b'],
    ["CASE(blank_text, 'x', 1, 0)", '0'],
    ['ISBLANK(blank_text)', 'true'],
    ['ISBLANK(name)', 'false'],
    ['ISBLANK(blank_number)', 'true'],
    ['ISBLANK(blank_flag)', 'false'],
    ['ISBLANK(tags)', 'false'],
    ['ISBLANK(stage)', 'false'],
    ["BLANKVALUE(blank_text, 'fallback')", 'fallback'],
    ["BLANKVALUE(name, 'fallback')", 'Maya Chen'],
    ['BLANKVALUE(blank_number, 0) + 1', '1'],
    // prior values
    ['ISCHANGED(amount)', 'true'],
    ['ISCHANGED(name)', 'false'],
    ['ISCHANGED(stage)', 'true'],
    ['PRIORVALUE(amount)', '1000'],
    ["ISPICKVAL(PRIORVALUE(stage), 'discovery')", 'true'],
    ['ISNEW()', 'false'],
    // picklists
    ["ISPICKVAL(stage, 'proposal')", 'true'],
    ["ISPICKVAL(stage, 'Proposal')", 'false'],
    ["INCLUDES(tags, 'vip')", 'true'],
    ["INCLUDES(tags, 'churn')", 'false'],
    ["TEXT(stage) & '!'", 'proposal!'],
    // text functions
    ['TEXT(amount)', '1250.5'],
    ['TEXT(employees)', '42'],
    ['TEXT(close_date)', '2026-10-31'],
    ['TEXT(created_at)', '2026-09-27 08:30:00Z'],
    ['TEXT(is_active)', 'true'],
    ['TEXT(blank_number)', 'null'],
    ["VALUE('12.50') * 2", '25'],
    ["VALUE(' 7 ')", '7'],
    ["VALUE('abc')", 'error:invalid_number'],
    ['VALUE(blank_text)', 'null'],
    ['LEN(name)', '9'],
    ['LEN(blank_text)', '0'],
    ["LEN('ﷺ😀')", '2'],
    ['LEFT(name, 4)', 'Maya'],
    ['LEFT(name, -1)', ''],
    ['LEFT(name, blank_number)', 'null'],
    ['RIGHT(name, 4)', 'Chen'],
    ['RIGHT(name, 0)', ''],
    ['RIGHT(name, blank_number)', 'null'],
    ['MID(name, 6, 2)', 'Ch'],
    ['MID(name, 0, 4)', 'Maya'],
    ['MID(name, 20, 4)', ''],
    ['MID(name, blank_number, 1)', 'null'],
    ["CONTAINS(email, '@pixelcraft')", 'true'],
    ["CONTAINS(email, '')", 'true'],
    ["CONTAINS(blank_text, 'a')", 'false'],
    ["BEGINS(name, 'Maya')", 'true'],
    ["BEGINS(name, 'maya')", 'false'],
    ['UPPER(name)', 'MAYA CHEN'],
    ['LOWER(name)', 'maya chen'],
    ['UPPER(blank_text)', 'null'],
    ['LOWER(blank_text)', 'null'],
    ["TRIM('  x  ')", 'x'],
    ['TRIM(blank_text)', 'null'],
    ["SUBSTITUTE(name, 'a', 'o')", 'Moyo Chen'],
    ["SUBSTITUTE(name, '', 'o')", 'Maya Chen'],
    ["SUBSTITUTE(blank_text, 'a', 'b')", 'null'],
    ["REGEX(email, '[a-z]+@[a-z]+\\\\.example')", 'true'],
    ["REGEX(email, 'maya')", 'false'],
    ["REGEX(blank_text, '')", 'true'],
    // numeric functions
    ['ROUND(2.5, 0)', '3'],
    ['ROUND(-2.5, 0)', '-3'],
    ['ROUND(amount, 0)', '1251'],
    ['ROUND(1.005, 2)', '1.01'],
    ['ROUND(1234.5, -2)', '1200'],
    ['ROUND(1250, -2)', '1300'],
    ['ROUND(blank_number, 2)', 'null'],
    ['FLOOR(-1.5)', '-2'],
    ['CEILING(1.2)', '2'],
    ['FLOOR(blank_number)', 'null'],
    ['CEILING(blank_number)', 'null'],
    ['ABS(-3)', '3'],
    ['ABS(blank_number)', 'null'],
    ['MIN(3, 1, 2)', '1'],
    ['MAX(amount, 2000)', '2000'],
    ['MAX(1, blank_number)', 'null'],
    ['MOD(10, 3)', '1'],
    ['MOD(-10, 3)', '-1'],
    ['MOD(10, 0)', 'error:division_by_zero'],
    ['MOD(blank_number, 3)', 'null'],
    // dates
    ['TODAY()', '2026-09-27'],
    ['NOW()', '2026-09-27T22:30:00.000Z'],
    ['DATE(2026, 2, 28)', '2026-02-28'],
    ['DATE(2026, 2, 29)', 'error:invalid_date'],
    ['DATE(2026, 13, 1)', 'error:invalid_date'],
    ['DATE(2026.5, 1, 1)', 'error:invalid_date'],
    ['DATE(blank_number, 1, 1)', 'null'],
    ["DATEVALUE('2026-09-27')", '2026-09-27'],
    ["DATEVALUE('2026-09-27T23:00:00Z')", '2026-09-27'],
    ["DATEVALUE('27/09/2026')", 'error:invalid_date'],
    ["DATEVALUE('2026-02-30')", 'error:invalid_date'],
    ['DATEVALUE(created_at)', '2026-09-27'],
    ['DATEVALUE(close_date)', '2026-10-31'],
    ['DATEVALUE(blank_text)', 'null'],
    ['YEAR(close_date)', '2026'],
    ['MONTH(close_date)', '10'],
    ['DAY(close_date)', '31'],
    ['WEEKDAY(close_date)', '7'],
    ['WEEKDAY(DATE(2026, 9, 27))', '1'],
    ['YEAR(blank_date)', 'null'],
    ['close_date + 1', '2026-11-01'],
    ['close_date - 31', '2026-09-30'],
    ['close_date + 1.9', '2026-11-01'],
    ['1 + close_date', '2026-11-01'],
    ['close_date - DATE(2026, 10, 1)', '30'],
    ['created_at + 0.5', '2026-09-27T20:30:00.000Z'],
    ['created_at - 1', '2026-09-26T08:30:00.000Z'],
    ['NOW() - created_at', '0.5833333333333333333333333333333333'],
    ['blank_date + 1', 'null'],
    ['ADDMONTHS(close_date, 1)', '2026-11-30'],
    ['ADDMONTHS(DATE(2026, 1, 31), 1)', '2026-02-28'],
    ['ADDMONTHS(DATE(2026, 2, 28), 1)', '2026-03-31'],
    ['ADDMONTHS(DATE(2026, 1, 15), -2)', '2025-11-15'],
    ['ADDMONTHS(created_at, 1)', '2026-10-27T08:30:00.000Z'],
    ['ADDMONTHS(blank_date, 1)', 'null'],
    ['DATEDIFF(DATE(2026, 9, 1), close_date)', '60'],
    ['DATEDIFF(close_date, DATE(2026, 9, 1))', '-60'],
    ['DATEDIFF(created_at, NOW())', '0'],
    ['DATEDIFF(blank_date, close_date)', 'null'],
    ['BUSINESSDAYS(DATE(2026, 9, 28), DATE(2026, 10, 5))', '5'],
    ['BUSINESSDAYS(DATE(2026, 10, 5), DATE(2026, 9, 28))', '-5'],
    ['BUSINESSDAYS(DATE(2026, 9, 26), DATE(2026, 9, 28))', '0'],
    ['BUSINESSDAYS(blank_date, close_date)', 'null'],
    // case-insensitive names and composition
    ["if(and(is_active, not(blank_flag)), upper(left(name, 1)), '')", 'M'],
    ["CASE(MONTH(close_date), 10, 'Q4', 'other')", 'Q4'],
  ])('%s → %s', (source, expected) => {
    if (expected === 'error:branch') {
      // IF only runs the branch it takes.
      expect(checkFormula(source, env).ok).toBe(false);
      return;
    }
    expect(run(source)).toBe(expected);
  });

  it('takes TODAY in the given time zone', () => {
    expect(run('TODAY()', { timezone: 'Asia/Qatar' })).toBe('2026-09-28');
    expect(run('TODAY()', { timezone: 'America/Los_Angeles' })).toBe('2026-09-27');
  });

  it('treats a new record as unchanged', () => {
    expect(run('ISNEW()', { isNew: true })).toBe('true');
    expect(run('ISCHANGED(amount)', { isNew: true })).toBe('false');
    expect(run('PRIORVALUE(amount)', { isNew: true })).toBe('1250.5');
  });

  it('refuses REGEX on very long text', () => {
    const checked = checkFormula("REGEX(name & name, 'a')", env);
    if (!checked.ok) throw new Error('check');
    const long = 'x'.repeat(6000);
    const result = evaluateFormula(checked.ast, {
      field: () => long,
      global: () => null,
      now: NOW,
      timezone: 'UTC',
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'regex_input_too_long' } });
  });
});

describe('value conversions and date helpers', () => {
  it('reads stored values into runtime values', () => {
    expect(fromStored('Number', '12.50')?.toString()).toBe('12.5');
    expect(fromStored('Number', 3)?.toString()).toBe('3');
    expect(fromStored('Number', new Decimal('1.5'))?.toString()).toBe('1.5');
    expect(fromStored('Number', '')).toBeNull();
    expect(fromStored('Number', 'abc')).toBeNull();
    expect(fromStored('Number', true)).toBeNull();
    expect(fromStored('Boolean', null)).toBe(false);
    expect(fromStored('Boolean', 'yes')).toBe(false);
    expect(fromStored('Date', new Date('2026-09-27T10:00:00Z'))).toBe('2026-09-27');
    expect(fromStored('Date', '2026-09-27T10:00:00Z')).toBe('2026-09-27');
    expect(fromStored('Date', 5)).toBeNull();
    expect(fromStored('DateTime', 'nope')).toBeNull();
    expect(fromStored('DateTime', 5)).toBeNull();
    const d = new Date();
    expect(fromStored('DateTime', d)).toBe(d);
    expect(fromStored('MultiPicklist', 'a;b')).toEqual(['a', 'b']);
    expect(fromStored('MultiPicklist', 5)).toBeNull();
    expect(fromStored('Text', 5)).toBe('5');
  });

  it('writes runtime values back as stored values', () => {
    expect(toStored(new Decimal('2.50'))).toBe('2.5');
    expect(toStored(new Date('2026-09-27T00:00:00Z'))).toBe('2026-09-27T00:00:00.000Z');
    expect(toStored(null)).toBeNull();
    expect(toStored('x')).toBe('x');
  });

  it('adds months and counts business days', () => {
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(businessDays('2026-09-28', '2026-09-28')).toBe(0);
    expect(businessDays('2026-09-25', '2026-10-09')).toBe(10);
    expect(dateIn(new Date('2026-12-31T23:30:00Z'), 'Asia/Dubai')).toBe('2027-01-01');
  });
});
