/** Source span of a node or token: [start, end) character offsets into the formula. */
export interface Span {
  start: number;
  end: number;
}

export type BinaryOp =
  '+' | '-' | '*' | '/' | '^' | '&' | '=' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||';
export type UnaryOp = '-' | '!';

export type Node =
  | { kind: 'number'; value: string; span: Span }
  | { kind: 'text'; value: string; span: Span }
  | { kind: 'boolean'; value: boolean; span: Span }
  | { kind: 'null'; span: Span }
  /** A field of the record, or of a related record through lookups (`account.owner.name`). */
  | { kind: 'field'; path: string[]; span: Span }
  /** `$User.email`, `$Org.name`. */
  | { kind: 'global'; scope: 'User' | 'Org'; name: string; span: Span }
  | { kind: 'unary'; op: UnaryOp; operand: Node; span: Span }
  | { kind: 'binary'; op: BinaryOp; left: Node; right: Node; span: Span }
  /** Function names are upper-cased (the language is case-insensitive for them). */
  | { kind: 'call'; name: string; args: Node[]; span: Span };

/** A problem found while parsing or type checking, with where it is (§5.5: shown in the editor). */
export interface FormulaError {
  /** Stable code; the UI translates `formula.errors.<code>` with `params`. */
  code: string;
  params: Record<string, string | number>;
  span: Span;
}

export class FormulaSyntaxError extends Error {
  constructor(readonly error: FormulaError) {
    super(`${error.code} at ${String(error.span.start)}`);
  }
}
