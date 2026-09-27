import type { BinaryOp, Span, UnaryOp } from './ast.js';

/** Value types of the language (§5.5), plus Time and multi-select picklists from §5.3. */
export type FormulaType =
  | 'Text'
  | 'Number'
  | 'Currency'
  | 'Percent'
  | 'Boolean'
  | 'Date'
  | 'DateTime'
  | 'Time'
  | 'Picklist'
  | 'MultiPicklist'
  | 'Null';

export const NUMERIC: ReadonlySet<FormulaType> = new Set(['Number', 'Currency', 'Percent']);
export const isNumeric = (t: FormulaType): boolean => NUMERIC.has(t);

/** A field as the checker sees it: its value type, and picklist values when it is one. */
export interface FieldInfo {
  type: FormulaType;
  picklistValues?: readonly string[];
}

export type FieldLookup =
  FieldInfo | { error: 'unknown_field' | 'not_a_relationship' | 'too_many_hops' };

export interface CheckEnvironment {
  /** Resolve a field of the record (`['email']`) or of a related record (`['account', 'name']`). */
  field(path: readonly string[]): FieldLookup;
  /** `$User.<name>` / `$Org.<name>`; null when unknown. */
  global(scope: 'User' | 'Org', name: string): FieldInfo | null;
  /** ISCHANGED, PRIORVALUE and ISNEW need a pending write: validation rules and automation. */
  allowPriorValues: boolean;
}

/** The AST after type checking: every node carries its type. */
export type TypedNode =
  | { kind: 'literal'; type: FormulaType; value: string | boolean | null; span: Span }
  | { kind: 'field'; type: FormulaType; path: string[]; span: Span }
  | { kind: 'global'; type: FormulaType; scope: 'User' | 'Org'; name: string; span: Span }
  | { kind: 'unary'; type: FormulaType; op: UnaryOp; operand: TypedNode; span: Span }
  | {
      kind: 'binary';
      type: FormulaType;
      op: BinaryOp;
      left: TypedNode;
      right: TypedNode;
      span: Span;
    }
  | { kind: 'call'; type: FormulaType; name: string; args: TypedNode[]; span: Span };
