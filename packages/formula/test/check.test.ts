import { describe, expect, it } from 'vitest';

import {
  checkFormula,
  FUNCTION_NAMES,
  unify,
  type CheckEnvironment,
  type FormulaType,
} from '../src/index.js';

const FIELDS: Record<string, FormulaType> = {
  amount: 'Currency',
  probability: 'Percent',
  employees: 'Number',
  name: 'Text',
  email: 'Text',
  is_active: 'Boolean',
  close_date: 'Date',
  created_at: 'DateTime',
  start_time: 'Time',
  stage: 'Picklist',
  tags: 'MultiPicklist',
  'account.name': 'Text',
  'account.annual_revenue': 'Currency',
  'account.owner.email': 'Text',
  'a.b.c.d.e.f': 'Text',
};

function env(allowPriorValues = true): CheckEnvironment {
  return {
    allowPriorValues,
    field: (path) => {
      const type = FIELDS[path.join('.')];
      if (type) return { type };
      if (path.length > 1 && path[0] === 'name') return { error: 'not_a_relationship' };
      return { error: 'unknown_field' };
    },
    global: (scope, name) => (scope === 'User' && name === 'email' ? { type: 'Text' } : null),
  };
}

const typeOf = (source: string, allowPrior = true) => {
  const r = checkFormula(source, env(allowPrior));
  if (!r.ok) throw new Error(`${source}: ${r.error.code} ${JSON.stringify(r.error.params)}`);
  return r.type;
};
const errorOf = (source: string, allowPrior = true, expected?: FormulaType) => {
  const r = checkFormula(source, env(allowPrior), expected);
  if (r.ok) throw new Error(`${source} should not type check`);
  return r.error;
};

describe('checkFormula: result types', () => {
  it.each([
    ['1', 'Number'],
    ["'x'", 'Text'],
    ['true', 'Boolean'],
    ['null', 'Null'],
    ['amount', 'Currency'],
    ['amount * 2', 'Currency'],
    ['amount + employees', 'Currency'],
    ['amount / amount', 'Number'],
    ['amount / 2', 'Currency'],
    ['employees / amount', 'Number'],
    ['probability * 2', 'Number'],
    ['2 ^ 3', 'Number'],
    ['amount ^ 2', 'Number'],
    ['-amount', 'Currency'],
    ['-null', 'Null'],
    ['close_date + 7', 'Date'],
    ['7 + close_date', 'Date'],
    ['close_date - 7', 'Date'],
    ['close_date - close_date', 'Number'],
    ['created_at + 1', 'DateTime'],
    ['created_at - created_at', 'Number'],
    ["name + '!'", 'Text'],
    ["name & ' ' & email", 'Text'],
    ['name & null', 'Text'],
    ['null + 1', 'Number'],
    ['null + null', 'Null'],
    ['null - close_date', 'Date'],
    ['amount > 1000', 'Boolean'],
    ['amount = employees', 'Boolean'],
    ['name < email', 'Boolean'],
    ['close_date >= TODAY()', 'Boolean'],
    ['start_time < start_time', 'Boolean'],
    ['is_active = true', 'Boolean'],
    ['name = null', 'Boolean'],
    ['is_active && !is_active || false', 'Boolean'],
    ['account.name', 'Text'],
    ['account.owner.email', 'Text'],
    ['$User.email', 'Text'],
    ['IF(is_active, amount, 0)', 'Currency'],
    ["IF(is_active, 'a', null)", 'Text'],
    ["IF(is_active, null, 'b')", 'Text'],
    ["CASE(stage, 'won', 1, 'lost', 0, 0.5)", 'Number'],
    ["CASE(employees, 1, 'one', 2, 'two', 'many')", 'Text'],
    ['AND(is_active, amount > 0, true)', 'Boolean'],
    ['OR(is_active)', 'Boolean'],
    ['NOT(is_active)', 'Boolean'],
    ['ISBLANK(stage)', 'Boolean'],
    ['ISBLANK(tags)', 'Boolean'],
    ['BLANKVALUE(amount, 0)', 'Currency'],
    ['ISCHANGED(stage)', 'Boolean'],
    ['PRIORVALUE(amount)', 'Currency'],
    ['ISNEW()', 'Boolean'],
    ["ISPICKVAL(stage, 'won')", 'Boolean'],
    ["INCLUDES(tags, 'vip')", 'Boolean'],
    ['TEXT(stage)', 'Text'],
    ['TEXT(amount)', 'Text'],
    ['TEXT(close_date)', 'Text'],
    ["VALUE('12')", 'Number'],
    ['LEN(name)', 'Number'],
    ['LEFT(name, 3)', 'Text'],
    ['RIGHT(name, 3)', 'Text'],
    ['MID(name, 2, 3)', 'Text'],
    ["CONTAINS(email, '@')", 'Boolean'],
    ["BEGINS(name, 'A')", 'Boolean'],
    ['UPPER(name)', 'Text'],
    ['LOWER(name)', 'Text'],
    ['TRIM(name)', 'Text'],
    ["SUBSTITUTE(name, 'a', 'b')", 'Text'],
    ["REGEX(email, '^[^@]+@example\\\\.com$')", 'Boolean'],
    ['ROUND(amount, 0)', 'Currency'],
    ['ROUND(null, 0)', 'Number'],
    ['FLOOR(probability)', 'Number'],
    ['CEILING(1.2)', 'Number'],
    ['ABS(amount)', 'Currency'],
    ['ABS(null)', 'Number'],
    ['MIN(1, 2, 3)', 'Number'],
    ['MAX(amount, 1)', 'Currency'],
    ['MOD(employees, 7)', 'Number'],
    ['TODAY()', 'Date'],
    ['NOW()', 'DateTime'],
    ['DATE(2026, 9, 27)', 'Date'],
    ["DATEVALUE('2026-09-27')", 'Date'],
    ['DATEVALUE(created_at)', 'Date'],
    ['YEAR(close_date)', 'Number'],
    ['MONTH(close_date)', 'Number'],
    ['DAY(close_date)', 'Number'],
    ['WEEKDAY(close_date)', 'Number'],
    ['ADDMONTHS(close_date, 3)', 'Date'],
    ['ADDMONTHS(created_at, 1)', 'DateTime'],
    ['ADDMONTHS(null, 1)', 'Date'],
    ['DATEDIFF(close_date, TODAY())', 'Number'],
    ['DATEDIFF(created_at, NOW())', 'Number'],
    ['BUSINESSDAYS(close_date, TODAY())', 'Number'],
    ['if(is_active, 1, 2)', 'Number'],
  ] as const)('%s : %s', (source, type) => {
    expect(typeOf(source)).toBe(type);
  });
});

describe('checkFormula: errors carry a code and where', () => {
  it.each([
    ['nope', 'unknown_field', 0, 4],
    ['1 + nope', 'unknown_field', 4, 8],
    ['name.first', 'not_a_relationship', 0, 10],
    ['a.b.c.d.e.f.g', 'too_many_hops', 0, 13],
    ['$User.salary', 'unknown_global', 0, 12],
    ["amount + 'x'", 'type_mismatch', 0, 12],
    ['is_active + 1', 'type_mismatch', 0, 13],
    ['close_date + close_date', 'type_mismatch', 0, 23],
    ['close_date - created_at', 'type_mismatch', 0, 23],
    ['name * 2', 'type_mismatch', 0, 8],
    ['name ^ 2', 'type_mismatch', 0, 8],
    ["amount / 'x'", 'type_mismatch', 0, 12],
    ['close_date = created_at', 'type_mismatch', 0, 23],
    ['is_active < true', 'type_mismatch', 0, 16],
    ['name = 1', 'type_mismatch', 0, 8],
    ["stage = 'won'", 'picklist_needs_function', 0, 5],
    ["tags = 'a'", 'picklist_needs_function', 0, 4],
    ['amount && true', 'expected_boolean', 0, 6],
    ['!amount', 'expected_boolean', 1, 7],
    ["-'x'", 'expected_number', 1, 4],
    ['1 & 2', 'expected_text', 0, 1],
    ['IF(amount, 1, 2)', 'expected_boolean', 3, 9],
    ["IF(is_active, 1, 'x')", 'branch_type_mismatch', 17, 20],
    ['IF(is_active, null, null)', 'cannot_infer_type', 0, 25],
    ['IF(is_active, 1)', 'wrong_argument_count', 0, 16],
    ["CASE(stage, 'a', 1, 'b', 2)", 'case_needs_else', 0, 27],
    ["CASE(employees, 'a', 1, 0)", 'type_mismatch', 16, 19],
    ['NOT(amount)', 'expected_boolean', 4, 10],
    ['ISCHANGED(amount * 2)', 'expected_field', 10, 20],
    ["ISPICKVAL(name, 'x')", 'expected_picklist', 10, 14],
    ['ISPICKVAL(stage, name)', 'expected_text_literal', 17, 21],
    ["INCLUDES(stage, 'x')", 'expected_multipicklist', 9, 14],
    ['TEXT(tags)', 'expected_text', 5, 9],
    ["REGEX(name, '(')", 'invalid_regex', 12, 15],
    ['LEN(amount)', 'expected_text', 4, 10],
    ["LEFT(name, 'x')", 'expected_number', 11, 14],
    ['ROUND(stage, 0)', 'picklist_needs_function', 6, 11],
    ["MAX(1, 'x')", 'expected_number', 7, 10],
    ['YEAR(created_at)', 'expected_date', 5, 15],
    ["DATEDIFF(close_date, 'x')", 'expected_date', 21, 24],
    ['FOO(1)', 'unknown_function', 0, 6],
    ['TODAY(1)', 'wrong_argument_count', 0, 8],
    ['AND()', 'wrong_argument_count', 0, 5],
  ] as const)('%s → %s [%d, %d)', (source, code, start, end) => {
    const error = errorOf(source);
    expect(error.code).toBe(code);
    expect(error.span).toEqual({ start, end });
  });

  it('refuses prior values outside validation rules and automation', () => {
    for (const source of ['ISCHANGED(amount)', 'PRIORVALUE(amount)', 'ISNEW()'])
      expect(errorOf(source, false).code).toBe('prior_not_allowed');
  });

  it('checks the result type the caller needs', () => {
    expect(errorOf('amount', true, 'Boolean')).toMatchObject({
      code: 'wrong_result_type',
      params: { expected: 'Boolean', found: 'Currency' },
    });
    expect(checkFormula('employees * 2', env(), 'Currency').ok).toBe(true);
    expect(checkFormula('null', env(), 'Boolean').ok).toBe(true);
    expect(checkFormula('amount > 0', env(), 'Boolean').ok).toBe(true);
  });

  it('reports syntax errors the same way', () => {
    expect(errorOf('1 +')).toMatchObject({ code: 'unexpected_end', span: { start: 3, end: 3 } });
  });

  it('names wrong argument counts helpfully', () => {
    expect(errorOf('MID(name, 1)').params).toEqual({ name: 'MID', min: 3, max: 3, found: 2 });
    expect(errorOf('MAX()').params).toMatchObject({ max: 'many' });
  });
});

describe('unify and the function list', () => {
  it('unifies numeric families and nulls', () => {
    expect(unify('Null', 'Text')).toBe('Text');
    expect(unify('Number', 'Currency')).toBe('Currency');
    expect(unify('Percent', 'Number')).toBe('Number');
    expect(unify('Text', 'Number')).toBeNull();
  });

  it('lists every §5.5 v1 function', () => {
    for (const name of [
      'IF',
      'CASE',
      'AND',
      'OR',
      'NOT',
      'ISBLANK',
      'BLANKVALUE',
      'ISCHANGED',
      'PRIORVALUE',
      'ISNEW',
      'ISPICKVAL',
      'INCLUDES',
      'TEXT',
      'VALUE',
      'LEN',
      'LEFT',
      'RIGHT',
      'MID',
      'CONTAINS',
      'BEGINS',
      'UPPER',
      'LOWER',
      'TRIM',
      'SUBSTITUTE',
      'REGEX',
      'ROUND',
      'FLOOR',
      'CEILING',
      'ABS',
      'MIN',
      'MAX',
      'MOD',
      'TODAY',
      'NOW',
      'DATE',
      'DATEVALUE',
      'YEAR',
      'MONTH',
      'DAY',
      'WEEKDAY',
      'ADDMONTHS',
      'DATEDIFF',
      'BUSINESSDAYS',
    ])
      expect(FUNCTION_NAMES).toContain(name);
  });
});
