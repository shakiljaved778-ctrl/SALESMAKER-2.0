import { describe, expect, it } from 'vitest';

import { FormulaSyntaxError, parse, tokenize, type Node } from '../src/index.js';

/** A compact s-expression of an AST, for readable expectations. */
function sexp(node: Node): string {
  switch (node.kind) {
    case 'number':
      return node.value;
    case 'text':
      return JSON.stringify(node.value);
    case 'boolean':
      return String(node.value);
    case 'null':
      return 'null';
    case 'field':
      return node.path.join('.');
    case 'global':
      return `$${node.scope}.${node.name}`;
    case 'unary':
      return `(${node.op} ${sexp(node.operand)})`;
    case 'binary':
      return `(${node.op} ${sexp(node.left)} ${sexp(node.right)})`;
    case 'call':
      return `${node.name}(${node.args.map(sexp).join(' ')})`;
  }
}

function syntaxError(source: string) {
  try {
    parse(source);
  } catch (err) {
    if (err instanceof FormulaSyntaxError) return err.error;
    throw err;
  }
  throw new Error(`expected a syntax error for ${source}`);
}

describe('tokenize', () => {
  it('reads numbers, text, identifiers, globals and operators with positions', () => {
    expect(
      tokenize("amount >= 1.5 && name <> 'x'").map((t) => [t.kind, t.value, t.span.start]),
    ).toEqual([
      ['ident', 'amount', 0],
      ['op', '>=', 7],
      ['number', '1.5', 10],
      ['op', '&&', 14],
      ['ident', 'name', 17],
      ['op', '!=', 22],
      ['text', 'x', 25],
      ['eof', '', 28],
    ]);
    expect(tokenize('$User.email == .5').map((t) => t.value)).toEqual([
      '$User.email',
      '=',
      '.5',
      '',
    ]);
  });

  it('unescapes text and skips whitespace and comments', () => {
    expect(
      tokenize(String.raw`'it\'s' "a\"b" 'tab\there\n' /* note */ 1`).map((t) => t.value),
    ).toEqual(["it's", 'a"b', 'tab\there\n', '1', '']);
  });

  it.each([
    ["'open", 'unterminated_text'],
    ['/* open', 'unterminated_comment'],
    [String.raw`'\q'`, 'invalid_escape'],
    ['1abc', 'invalid_number'],
    ['a # b', 'unexpected_character'],
    ['$', 'unexpected_character'],
    ['a'.repeat(5001), 'too_long'],
  ])('rejects %s (%s)', (source, code) => {
    expect(syntaxError(source).code).toBe(code);
  });
});

describe('parse', () => {
  it.each([
    ['1 + 2 * 3', '(+ 1 (* 2 3))'],
    ['(1 + 2) * 3', '(* (+ 1 2) 3)'],
    ['1 - 2 - 3', '(- (- 1 2) 3)'],
    ['2 ^ 3 ^ 2', '(^ 2 (^ 3 2))'],
    ['-2 ^ 2', '(^ (- 2) 2)'],
    ['a & b & c', '(& (& a b) c)'],
    ['a + b & c', '(& (+ a b) c)'],
    ['a = 1 && b != 2 || c', '(|| (&& (= a 1) (!= b 2)) c)'],
    ['a < b = true', '(= (< a b) true)'],
    ['!a && b', '(&& (! a) b)'],
    ['!(a && b)', '(! (&& a b))'],
    ['+5', '5'],
    ['--5', '(- (- 5))'],
    ['.5', '0.5'],
    ['Amount', 'amount'],
    ['Account.Owner.Name', 'account.owner.name'],
    ['$user.EMAIL', '$User.email'],
    ['$Org.name', '$Org.name'],
    ['TRUE || false', '(|| true false)'],
    ['NULL', 'null'],
    ["if(a, 'x', 'y')", 'IF(a "x" "y")'],
    ['TODAY()', 'TODAY()'],
    ['max(1, min(2, 3), 4)', 'MAX(1 MIN(2 3) 4)'],
    ['a == b', '(= a b)'],
    ['a <> b', '(!= a b)'],
  ])('%s → %s', (source, expected) => {
    expect(sexp(parse(source))).toBe(expected);
  });

  it('spans cover each node and parentheses', () => {
    const node = parse('(a + bb) * 3');
    expect(node.span).toEqual({ start: 0, end: 12 });
    if (node.kind !== 'binary') throw new Error('binary');
    expect(node.left.span).toEqual({ start: 0, end: 8 });
    expect(node.right.span).toEqual({ start: 11, end: 12 });
  });

  it.each([
    ['', 'empty', 0],
    ['   ', 'empty', 3],
    ['1 +', 'unexpected_end', 3],
    ['(1 + 2', 'expected_close_paren', 6],
    ['IF(a, b', 'expected_close_paren', 7],
    ['1 2', 'unexpected_token', 2],
    ['* 2', 'unexpected_token', 0],
    [')', 'unexpected_token', 0],
    [',', 'unexpected_token', 0],
    ['a !', 'unexpected_token', 2],
    ['account.name(1)', 'unknown_function', 0],
    ['$Company.name', 'unknown_global', 0],
    ['$User.a.b', 'unknown_global', 0],
  ])('rejects %j with %s at %d', (source, code, start) => {
    const error = syntaxError(source);
    expect(error.code).toBe(code);
    expect(error.span.start).toBe(start);
  });

  it('refuses nesting deeper than 100', () => {
    expect(syntaxError(`${'('.repeat(150)}1${')'.repeat(150)}`).code).toBe('too_deep');
    expect(sexp(parse(`${'('.repeat(50)}1${')'.repeat(50)}`))).toBe('1');
  });
});
