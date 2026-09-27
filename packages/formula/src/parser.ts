import { FormulaSyntaxError, type BinaryOp, type Node, type Span } from './ast.js';
import { tokenize, type Token } from './lexer.js';

/**
 * Binding powers (low → high): `||` < `&&` < `=` `!=` < `<` `<=` `>` `>=` < `&` < `+` `-` <
 * `*` `/` < `^` (right-associative) < unary `-` `!`.
 */
const INFIX: Record<string, [left: number, right: number]> = {
  '||': [10, 11],
  '&&': [20, 21],
  '=': [30, 31],
  '!=': [30, 31],
  '<': [40, 41],
  '<=': [40, 41],
  '>': [40, 41],
  '>=': [40, 41],
  '&': [50, 51],
  '+': [60, 61],
  '-': [60, 61],
  '*': [70, 71],
  '/': [70, 71],
  '^': [81, 80],
};
const PREFIX = 90;
/** Nesting deeper than this is refused rather than risking the stack. */
const MAX_DEPTH = 100;

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos] ?? (this.tokens.at(-1) as Token);
  }

  private next(): Token {
    const t = this.peek();
    if (t.kind !== 'eof') this.pos += 1;
    return t;
  }

  private fail(code: string, span: Span, params: Record<string, string | number> = {}): never {
    throw new FormulaSyntaxError({ code, params, span });
  }

  private expect(kind: Token['kind'], code: string): Token {
    const t = this.peek();
    if (t.kind !== kind) this.fail(code, t.span, { found: describe(t) });
    return this.next();
  }

  parse(): Node {
    if (this.peek().kind === 'eof') this.fail('empty', this.peek().span);
    const node = this.expression(0);
    const rest = this.peek();
    if (rest.kind !== 'eof') this.fail('unexpected_token', rest.span, { found: describe(rest) });
    return node;
  }

  private expression(minPower: number): Node {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) this.fail('too_deep', this.peek().span, { max: MAX_DEPTH });
    let left = this.prefix();
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'op') break;
      const power = INFIX[t.value];
      if (!power) this.fail('unexpected_token', t.span, { found: describe(t) });
      const [l, r] = power;
      if (l < minPower) break;
      this.next();
      const right = this.expression(r);
      left = {
        kind: 'binary',
        op: t.value as BinaryOp,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      };
    }
    this.depth -= 1;
    return left;
  }

  private prefix(): Node {
    const t = this.next();
    switch (t.kind) {
      case 'number':
        return {
          kind: 'number',
          value: t.value.startsWith('.') ? `0${t.value}` : t.value,
          span: t.span,
        };
      case 'text':
        return { kind: 'text', value: t.value, span: t.span };
      case 'global': {
        const [scope, ...rest] = t.value.slice(1).split('.');
        const normalised =
          scope?.toLowerCase() === 'user' ? 'User' : scope?.toLowerCase() === 'org' ? 'Org' : null;
        if (!normalised || rest.length !== 1)
          this.fail('unknown_global', t.span, { name: t.value });
        return {
          kind: 'global',
          scope: normalised,
          name: (rest[0] ?? '').toLowerCase(),
          span: t.span,
        };
      }
      case 'ident': {
        if (this.peek().kind === '(') return this.call(t);
        const upper = t.value.toUpperCase();
        if (upper === 'TRUE' || upper === 'FALSE')
          return { kind: 'boolean', value: upper === 'TRUE', span: t.span };
        if (upper === 'NULL') return { kind: 'null', span: t.span };
        return { kind: 'field', path: t.value.toLowerCase().split('.'), span: t.span };
      }
      case '(': {
        const inner = this.expression(0);
        const close = this.expect(')', 'expected_close_paren');
        return { ...inner, span: { start: t.span.start, end: close.span.end } };
      }
      case 'op':
        if (t.value === '-' || t.value === '!') {
          const operand = this.expression(PREFIX);
          return {
            kind: 'unary',
            op: t.value,
            operand,
            span: { start: t.span.start, end: operand.span.end },
          };
        }
        if (t.value === '+') return this.expression(PREFIX); // unary plus is a no-op
        return this.fail('unexpected_token', t.span, { found: describe(t) });
      case 'eof':
        return this.fail('unexpected_end', t.span);
      default:
        return this.fail('unexpected_token', t.span, { found: describe(t) });
    }
  }

  private call(name: Token): Node {
    if (name.value.includes('.')) this.fail('unknown_function', name.span, { name: name.value });
    this.next(); // (
    const args: Node[] = [];
    if (this.peek().kind !== ')') {
      for (;;) {
        args.push(this.expression(0));
        if (this.peek().kind === ',') {
          this.next();
          continue;
        }
        break;
      }
    }
    const close = this.expect(')', 'expected_close_paren');
    return {
      kind: 'call',
      name: name.value.toUpperCase(),
      args,
      span: { start: name.span.start, end: close.span.end },
    };
  }
}

function describe(t: Token): string {
  return t.kind === 'eof' ? 'end' : t.value || t.kind;
}

/** Parse a formula into its AST, or throw `FormulaSyntaxError` with the position of the problem. */
export function parse(source: string): Node {
  return new Parser(tokenize(source)).parse();
}
