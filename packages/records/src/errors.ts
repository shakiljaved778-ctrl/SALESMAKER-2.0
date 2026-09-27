/** A field-level problem with a write, reported by API name (§10.1 `errors[{field, code}]`). */
export interface FieldError {
  field: string;
  code: string;
  /** Validation rules carry the admin's message. */
  message?: string;
}

export type RecordErrorCode =
  /** The object or record does not exist, or the caller cannot see it (never 403, §3.5). */
  | 'not_found'
  /** The caller can see it but may not do this (object permission, record access, FLS). */
  | 'forbidden'
  /** Malformed input: unknown or read-only fields, wrong types. */
  | 'invalid'
  /** Well-formed but refused by the data: required fields, validation rules, references. */
  | 'unprocessable'
  /** Someone changed the record since the caller read it (`version`), or it is locked. */
  | 'conflict';

const STATUS: Record<RecordErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  invalid: 400,
  unprocessable: 422,
  conflict: 409,
};

export class RecordError extends Error {
  readonly status: number;

  constructor(
    readonly code: RecordErrorCode,
    readonly errors: FieldError[] = [],
    /** On a version conflict: the record as it is now, so the caller can show what changed. */
    readonly current?: Record<string, unknown>,
  ) {
    super(
      errors.length ? `${code}: ${errors.map((e) => `${e.field} ${e.code}`).join(', ')}` : code,
    );
    this.status = STATUS[code];
  }
}
