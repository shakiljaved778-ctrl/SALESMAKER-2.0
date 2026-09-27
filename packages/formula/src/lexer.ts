import { FormulaSyntaxError, type Span } from './ast.js';

export type TokenKind = 'number' | 'text' | 'ident' | 'global' | 'op' | '(' | ')' | ',' | 'eof';

export interface Token {
  kind: TokenKind;
  /** Numbers: the digits; text: the unescaped string; identifiers: as written; ops: canonical. */
  value: string;
  span: Span;
}

/** Longest first, so `<=` wins over `<`. `==` and `<>` are accepted spellings of `=` and `!=`. */
const OPERATORS: [string, string][] = [
  ['&&', '&&'],
  ['||', '||'],
  ['==', '='],
  ['!=', '!='],
  ['<>', '!='],
  ['<=', '<='],
  ['>=', '>='],
  ['+', '+'],
  ['-', '-'],
  ['*', '*'],
  ['/', '/'],
  ['^', '^'],
  ['&', '&'],
  ['=', '='],
  ['<', '<'],
  ['>', '>'],
  ['!', '!'],
];

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
/** Formulas are short admin-authored expressions; a hard cap keeps parsing and evaluation cheap. */
export const MAX_FORMULA_LENGTH = 5000;

export function tokenize(source: string): Token[] {
  if (source.length > MAX_FORMULA_LENGTH)
    throw new FormulaSyntaxError({
      code: 'too_long',
      params: { max: MAX_FORMULA_LENGTH },
      span: { start: MAX_FORMULA_LENGTH, end: source.length },
    });
  const tokens: Token[] = [];
  let i = 0;
  const fail = (code: string, start: number, end = start + 1, params = {}): never => {
    throw new FormulaSyntaxError({ code, params, span: { start, end } });
  };
  while (i < source.length) {
    const c = source.charAt(i);
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    // Comments: /* … */
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) fail('unterminated_comment', i, source.length);
      i = end + 2;
      continue;
    }
    const start = i;
    if (DIGIT.test(c) || (c === '.' && DIGIT.test(source.charAt(i + 1)))) {
      while (DIGIT.test(source.charAt(i))) i += 1;
      if (source[i] === '.') {
        i += 1;
        while (DIGIT.test(source.charAt(i))) i += 1;
      }
      if (IDENT_START.test(source.charAt(i))) fail('invalid_number', start, i + 1);
      tokens.push({ kind: 'number', value: source.slice(start, i), span: { start, end: i } });
      continue;
    }
    if (c === "'" || c === '"') {
      i += 1;
      let value = '';
      for (;;) {
        if (i >= source.length) fail('unterminated_text', start, source.length);
        const ch = source.charAt(i);
        if (ch === c) {
          i += 1;
          break;
        }
        if (ch === '\\') {
          const next = source.charAt(i + 1);
          const escapes: Record<string, string> = {
            n: '\n',
            t: '\t',
            '\\': '\\',
            "'": "'",
            '"': '"',
          };
          const decoded = escapes[next];
          if (decoded === undefined) return fail('invalid_escape', i, i + 2);
          value += decoded;
          i += 2;
          continue;
        }
        value += ch;
        i += 1;
      }
      tokens.push({ kind: 'text', value, span: { start, end: i } });
      continue;
    }
    if (c === '$' || IDENT_START.test(c)) {
      i += 1;
      // Dotted paths are one token: `account.owner.name`, `$User.email`.
      while (
        IDENT_PART.test(source.charAt(i)) ||
        (source[i] === '.' && IDENT_START.test(source.charAt(i + 1)))
      )
        i += 1;
      const value = source.slice(start, i);
      if (c === '$' && value.length === 1) fail('unexpected_character', start);
      tokens.push({ kind: c === '$' ? 'global' : 'ident', value, span: { start, end: i } });
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      tokens.push({ kind: c, value: c, span: { start, end: i + 1 } });
      i += 1;
      continue;
    }
    const op = OPERATORS.find(([spelling]) => source.startsWith(spelling, i));
    if (op) {
      tokens.push({ kind: 'op', value: op[1], span: { start, end: i + op[0].length } });
      i += op[0].length;
      continue;
    }
    fail('unexpected_character', start, start + 1, { character: c });
  }
  tokens.push({ kind: 'eof', value: '', span: { start: source.length, end: source.length } });
  return tokens;
}
