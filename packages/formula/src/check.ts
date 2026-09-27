import { FormulaSyntaxError, type FormulaError, type Node, type Span } from './ast.js';
import { parse } from './parser.js';
import { isNumeric, type CheckEnvironment, type FormulaType, type TypedNode } from './types.js';

/** Cross-object references may follow at most this many lookups (§5.5). */
export const MAX_HOPS = 5;

class FormulaTypeError extends Error {
  constructor(readonly error: FormulaError) {
    super(error.code);
  }
}

const fail = (code: string, span: Span, params: Record<string, string | number> = {}): never => {
  throw new FormulaTypeError({ code, params, span });
};

/** The common type of two branches (IF, CASE, BLANKVALUE, MIN/MAX), or null when there is none. */
export function unify(a: FormulaType, b: FormulaType): FormulaType | null {
  if (a === 'Null') return b;
  if (b === 'Null') return a;
  if (a === b) return a;
  if (isNumeric(a) && isNumeric(b))
    return a === 'Currency' || b === 'Currency' ? 'Currency' : 'Number';
  return null;
}

function arithmetic(op: string, a: FormulaType, b: FormulaType): FormulaType | null {
  if (a === 'Null' || b === 'Null') {
    const other = a === 'Null' ? b : a;
    return other === 'Null' ||
      isNumeric(other) ||
      other === 'Date' ||
      other === 'DateTime' ||
      (op === '+' && other === 'Text')
      ? other === 'Null'
        ? 'Null'
        : other
      : null;
  }
  const bothNumeric = isNumeric(a) && isNumeric(b);
  switch (op) {
    case '+':
      if (bothNumeric) return a === 'Currency' || b === 'Currency' ? 'Currency' : 'Number';
      if (a === 'Text' && b === 'Text') return 'Text';
      if ((a === 'Date' || a === 'DateTime') && isNumeric(b)) return a;
      if (isNumeric(a) && (b === 'Date' || b === 'DateTime')) return b;
      return null;
    case '-':
      if (bothNumeric) return a === 'Currency' || b === 'Currency' ? 'Currency' : 'Number';
      if ((a === 'Date' || a === 'DateTime') && isNumeric(b)) return a;
      if (a === b && (a === 'Date' || a === 'DateTime')) return 'Number';
      return null;
    case '*':
      return bothNumeric ? (a === 'Currency' || b === 'Currency' ? 'Currency' : 'Number') : null;
    case '/':
      return bothNumeric ? (a === 'Currency' && b !== 'Currency' ? 'Currency' : 'Number') : null;
    case '^':
      return bothNumeric ? 'Number' : null;
    default:
      return null;
  }
}

const COMPARABLE: ReadonlySet<FormulaType> = new Set([
  'Text',
  'Boolean',
  'Date',
  'DateTime',
  'Time',
]);
const ORDERED: ReadonlySet<FormulaType> = new Set(['Text', 'Date', 'DateTime', 'Time']);

class Checker {
  constructor(private readonly env: CheckEnvironment) {}

  check(node: Node): TypedNode {
    switch (node.kind) {
      case 'number':
        return { kind: 'literal', type: 'Number', value: node.value, span: node.span };
      case 'text':
        return { kind: 'literal', type: 'Text', value: node.value, span: node.span };
      case 'boolean':
        return { kind: 'literal', type: 'Boolean', value: node.value, span: node.span };
      case 'null':
        return { kind: 'literal', type: 'Null', value: null, span: node.span };
      case 'field': {
        if (node.path.length - 1 > MAX_HOPS) fail('too_many_hops', node.span, { max: MAX_HOPS });
        const found = this.env.field(node.path);
        if ('error' in found) fail(found.error, node.span, { name: node.path.join('.') });
        const info = found as Exclude<typeof found, { error: unknown }>;
        return { kind: 'field', type: info.type, path: node.path, span: node.span };
      }
      case 'global': {
        const info = this.env.global(node.scope, node.name);
        if (!info) fail('unknown_global', node.span, { name: `$${node.scope}.${node.name}` });
        return {
          kind: 'global',
          type: (info as { type: FormulaType }).type,
          scope: node.scope,
          name: node.name,
          span: node.span,
        };
      }
      case 'unary': {
        const operand = this.check(node.operand);
        if (node.op === '-') {
          if (!isNumeric(operand.type) && operand.type !== 'Null')
            fail('expected_number', operand.span, { found: operand.type });
          return { kind: 'unary', type: operand.type, op: '-', operand, span: node.span };
        }
        this.expectType(operand, 'Boolean');
        return { kind: 'unary', type: 'Boolean', op: '!', operand, span: node.span };
      }
      case 'binary':
        return this.binary(node);
      case 'call':
        return this.call(node);
    }
  }

  private expectType(node: TypedNode, ...types: FormulaType[]): void {
    if (node.type === 'Null' || types.includes(node.type)) return;
    if (node.type === 'Picklist') fail('picklist_needs_function', node.span);
    fail(`expected_${types[0]?.toLowerCase() ?? 'value'}`, node.span, { found: node.type });
  }

  private binary(node: Extract<Node, { kind: 'binary' }>): TypedNode {
    const left = this.check(node.left);
    const right = this.check(node.right);
    const typed = (type: FormulaType): TypedNode => ({
      kind: 'binary',
      type,
      op: node.op,
      left,
      right,
      span: node.span,
    });
    for (const side of [left, right])
      if (side.type === 'Picklist' || side.type === 'MultiPicklist')
        fail('picklist_needs_function', side.span);
    switch (node.op) {
      case '&&':
      case '||':
        this.expectType(left, 'Boolean');
        this.expectType(right, 'Boolean');
        return typed('Boolean');
      case '&':
        this.expectType(left, 'Text');
        this.expectType(right, 'Text');
        return typed('Text');
      case '=':
      case '!=': {
        const ok =
          left.type === 'Null' ||
          right.type === 'Null' ||
          (isNumeric(left.type) && isNumeric(right.type)) ||
          (left.type === right.type && COMPARABLE.has(left.type));
        if (!ok) fail('type_mismatch', node.span, { left: left.type, right: right.type });
        return typed('Boolean');
      }
      case '<':
      case '<=':
      case '>':
      case '>=': {
        const ok =
          left.type === 'Null' ||
          right.type === 'Null' ||
          (isNumeric(left.type) && isNumeric(right.type)) ||
          (left.type === right.type && ORDERED.has(left.type));
        if (!ok) fail('type_mismatch', node.span, { left: left.type, right: right.type });
        return typed('Boolean');
      }
      default: {
        const type = arithmetic(node.op, left.type, right.type);
        if (!type) fail('type_mismatch', node.span, { left: left.type, right: right.type });
        return typed(type as FormulaType);
      }
    }
  }

  private call(node: Extract<Node, { kind: 'call' }>): TypedNode {
    const spec = FUNCTIONS[node.name];
    if (!spec) return fail('unknown_function', node.span, { name: node.name });
    const [min, max] = spec.arity;
    if (node.args.length < min || node.args.length > max)
      fail('wrong_argument_count', node.span, {
        name: node.name,
        min,
        max: max === Infinity ? 'many' : max,
        found: node.args.length,
      });
    if (spec.prior && !this.env.allowPriorValues)
      fail('prior_not_allowed', node.span, { name: node.name });
    const args = node.args.map((a) => this.check(a));
    const type = spec.check(args, node, this);
    return { kind: 'call', type, name: node.name, args, span: node.span };
  }

  /** Helpers the function table uses. */
  readonly h = {
    expect: (node: TypedNode, ...types: FormulaType[]) => {
      this.expectType(node, ...types);
    },
    numeric: (node: TypedNode) => {
      if (node.type !== 'Null' && !isNumeric(node.type))
        fail(node.type === 'Picklist' ? 'picklist_needs_function' : 'expected_number', node.span, {
          found: node.type,
        });
    },
    field: (node: TypedNode, name: string) => {
      if (node.kind !== 'field') fail('expected_field', node.span, { name });
    },
    literalText: (node: TypedNode, name: string) => {
      if (node.kind !== 'literal' || node.type !== 'Text')
        fail('expected_text_literal', node.span, { name });
    },
    unify: (nodes: TypedNode[], span: Span): FormulaType => {
      let type: FormulaType = 'Null';
      for (const n of nodes) {
        const next = unify(type, n.type);
        if (!next) fail('branch_type_mismatch', n.span, { expected: type, found: n.type });
        type = next as FormulaType;
      }
      return type === 'Null' ? fail('cannot_infer_type', span) : type;
    },
  };
}

interface FunctionSpec {
  arity: [number, number];
  /** Needs a pending write (ISCHANGED, PRIORVALUE, ISNEW). */
  prior?: boolean;
  check(args: TypedNode[], node: Extract<Node, { kind: 'call' }>, c: Checker): FormulaType;
}

const text1 = (arity: [number, number], out: FormulaType, numberArgs = 0): FunctionSpec => ({
  arity,
  check: (args, _n, c) => {
    c.h.expect(args[0] as TypedNode, 'Text');
    for (const a of args.slice(1, 1 + numberArgs)) c.h.numeric(a);
    for (const a of args.slice(1 + numberArgs)) c.h.expect(a, 'Text');
    return out;
  },
});

/** Every argument must be one of `types` (numeric family when `types` is 'numeric'); returns `out`. */
const each = (
  arity: [number, number],
  types: FormulaType[] | 'numeric',
  out: FormulaType,
): FunctionSpec => ({
  arity,
  check: (args, _n, c) => {
    for (const a of args) {
      if (types === 'numeric') c.h.numeric(a);
      else c.h.expect(a, ...types);
    }
    return out;
  },
});

/** Numeric arguments; the result is their common numeric type (MIN, MAX). */
const numericUnify: FunctionSpec = {
  arity: [1, Infinity],
  check: (args, n, c) => {
    for (const a of args) c.h.numeric(a);
    return c.h.unify(args, n.span);
  },
};

const FUNCTIONS: Record<string, FunctionSpec> = {
  IF: {
    arity: [3, 3],
    check: ([cond, a, b], n, c) => {
      c.h.expect(cond as TypedNode, 'Boolean');
      return c.h.unify([a as TypedNode, b as TypedNode], n.span);
    },
  },
  CASE: {
    // CASE(expr, value1, result1, …, else): an even number of arguments, at least four.
    arity: [4, Infinity],
    check: (args, n, c) => {
      if (args.length % 2 !== 0) fail('case_needs_else', n.span);
      const [expr, ...rest] = args as [TypedNode, ...TypedNode[]];
      const subject: FormulaType = expr.type === 'Picklist' ? 'Text' : expr.type;
      const results: TypedNode[] = [];
      for (let i = 0; i < rest.length - 1; i += 2) {
        const value = rest[i] as TypedNode;
        if (!unify(subject, value.type))
          fail('type_mismatch', value.span, { left: subject, right: value.type });
        results.push(rest[i + 1] as TypedNode);
      }
      results.push(rest.at(-1) as TypedNode);
      return c.h.unify(results, n.span);
    },
  },
  AND: each([1, Infinity], ['Boolean'], 'Boolean'),
  OR: each([1, Infinity], ['Boolean'], 'Boolean'),
  NOT: each([1, 1], ['Boolean'], 'Boolean'),
  ISBLANK: { arity: [1, 1], check: () => 'Boolean' },
  BLANKVALUE: {
    arity: [2, 2],
    check: ([a, b], n, c) => c.h.unify([a as TypedNode, b as TypedNode], n.span),
  },
  ISCHANGED: {
    arity: [1, 1],
    prior: true,
    check: ([a], _n, c) => (c.h.field(a as TypedNode, 'ISCHANGED'), 'Boolean'),
  },
  PRIORVALUE: {
    arity: [1, 1],
    prior: true,
    check: ([a], _n, c) => {
      c.h.field(a as TypedNode, 'PRIORVALUE');
      return (a as TypedNode).type;
    },
  },
  ISNEW: { arity: [0, 0], prior: true, check: () => 'Boolean' },
  ISPICKVAL: {
    arity: [2, 2],
    check: ([field, value], _n, c) => {
      const f = field as TypedNode;
      if (f.type !== 'Picklist') fail('expected_picklist', f.span, { found: f.type });
      c.h.literalText(value as TypedNode, 'ISPICKVAL');
      return 'Boolean';
    },
  },
  INCLUDES: {
    arity: [2, 2],
    check: ([field, value], _n, c) => {
      const f = field as TypedNode;
      if (f.type !== 'MultiPicklist') fail('expected_multipicklist', f.span, { found: f.type });
      c.h.literalText(value as TypedNode, 'INCLUDES');
      return 'Boolean';
    },
  },
  TEXT: {
    arity: [1, 1],
    check: ([a]) => {
      const t = (a as TypedNode).type;
      if (t === 'MultiPicklist') fail('expected_text', (a as TypedNode).span, { found: t });
      return 'Text';
    },
  },
  VALUE: each([1, 1], ['Text'], 'Number'),
  LEN: text1([1, 1], 'Number'),
  LEFT: text1([2, 2], 'Text', 1),
  RIGHT: text1([2, 2], 'Text', 1),
  MID: text1([3, 3], 'Text', 2),
  CONTAINS: text1([2, 2], 'Boolean'),
  BEGINS: text1([2, 2], 'Boolean'),
  UPPER: text1([1, 1], 'Text'),
  LOWER: text1([1, 1], 'Text'),
  TRIM: text1([1, 1], 'Text'),
  SUBSTITUTE: text1([3, 3], 'Text'),
  REGEX: {
    arity: [2, 2],
    check: ([a, pattern], _n, c) => {
      c.h.expect(a as TypedNode, 'Text');
      const p = pattern as TypedNode;
      c.h.literalText(p, 'REGEX');
      try {
        new RegExp(String((p as { value: unknown }).value), 'u');
      } catch {
        fail('invalid_regex', p.span);
      }
      return 'Boolean';
    },
  },
  ROUND: {
    arity: [2, 2],
    check: ([a, digits], _n, c) => {
      c.h.numeric(a as TypedNode);
      c.h.numeric(digits as TypedNode);
      return (a as TypedNode).type === 'Null' ? 'Number' : (a as TypedNode).type;
    },
  },
  FLOOR: each([1, 1], 'numeric', 'Number'),
  CEILING: each([1, 1], 'numeric', 'Number'),
  ABS: {
    arity: [1, 1],
    check: ([a], _n, c) => {
      c.h.numeric(a as TypedNode);
      return (a as TypedNode).type === 'Null' ? 'Number' : (a as TypedNode).type;
    },
  },
  MIN: numericUnify,
  MAX: numericUnify,
  MOD: each([2, 2], 'numeric', 'Number'),
  TODAY: { arity: [0, 0], check: () => 'Date' },
  NOW: { arity: [0, 0], check: () => 'DateTime' },
  DATE: each([3, 3], 'numeric', 'Date'),
  DATEVALUE: each([1, 1], ['Text', 'DateTime', 'Date'], 'Date'),
  YEAR: each([1, 1], ['Date'], 'Number'),
  MONTH: each([1, 1], ['Date'], 'Number'),
  DAY: each([1, 1], ['Date'], 'Number'),
  WEEKDAY: each([1, 1], ['Date'], 'Number'),
  ADDMONTHS: {
    arity: [2, 2],
    check: ([a, months], _n, c) => {
      c.h.expect(a as TypedNode, 'Date', 'DateTime');
      c.h.numeric(months as TypedNode);
      return (a as TypedNode).type === 'Null' ? 'Date' : (a as TypedNode).type;
    },
  },
  // DATEDIFF(start, end): whole days from start to end.
  DATEDIFF: each([2, 2], ['Date', 'DateTime'], 'Number'),
  // BUSINESSDAYS(start, end): Monday–Friday days from start (inclusive) to end (exclusive).
  BUSINESSDAYS: each([2, 2], ['Date'], 'Number'),
};

/** Names of the built-in functions (for the editor's autocomplete). */
export const FUNCTION_NAMES: readonly string[] = Object.keys(FUNCTIONS).sort();

export type CheckResult =
  { ok: true; ast: TypedNode; type: FormulaType } | { ok: false; error: FormulaError };

/**
 * Parse and type check a formula. `expected` constrains the result (validation rules and
 * conditions must be Boolean); numeric results satisfy any numeric expectation.
 */
export function checkFormula(
  source: string,
  env: CheckEnvironment,
  expected?: FormulaType,
): CheckResult {
  try {
    const ast = new Checker(env).check(parse(source));
    if (
      expected &&
      ast.type !== expected &&
      !(isNumeric(expected) && isNumeric(ast.type)) &&
      ast.type !== 'Null'
    )
      fail('wrong_result_type', ast.span, { expected, found: ast.type });
    return { ok: true, ast, type: ast.type };
  } catch (err) {
    if (err instanceof FormulaSyntaxError || err instanceof FormulaTypeError)
      return { ok: false, error: err.error };
    throw err;
  }
}
