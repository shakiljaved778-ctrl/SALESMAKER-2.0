import { QueryError } from '@sm/query-engine';
import { RecordError } from '@sm/records';
import { DomainError, errors } from '@sm/server-kit';

const MESSAGES: Record<string, string> = {
  not_found: 'Record not found',
  forbidden: 'You do not have access to this record or field',
  invalid: 'Some fields need attention',
  unprocessable: 'The record could not be saved',
  conflict: 'The record changed or is locked; reload and try again',
};

/**
 * RecordService and Query Engine failures as RFC 9457 problems (§10.1). A field the caller may
 * not read is reported exactly like one that does not exist, so FLS never leaks a field's
 * existence (§6.5).
 */
export function toProblem(err: unknown): unknown {
  if (err instanceof RecordError) {
    const fieldErrors = err.errors.map((e) => ({
      field: e.field,
      code: e.code,
      message: e.message ?? e.code,
    }));
    const withFields = fieldErrors.length ? fieldErrors : undefined;
    const message = MESSAGES[err.code] ?? err.code;
    switch (err.code) {
      case 'not_found':
        return errors.notFound('Record');
      case 'forbidden':
        return new DomainError('forbidden', 403, message, withFields);
      case 'invalid':
        return new DomainError('validation_failed', 400, message, withFields);
      case 'unprocessable':
        return new DomainError('validation_failed', 422, message, withFields);
      case 'conflict':
        return new DomainError(
          err.errors.some((e) => e.code === 'version_mismatch') ? 'version_conflict' : 'conflict',
          409,
          message,
          withFields,
        );
    }
  }
  if (err instanceof QueryError) {
    if (err.code === 'unknown_object') return errors.notFound('Object');
    const code = err.code === 'field_not_readable' ? 'unknown_field' : err.code;
    return errors.validation([
      { field: err.field ?? '_query', code, message: `The query is not valid (${code})` },
    ]);
  }
  return err;
}

/** Run `fn`, translating record and query errors. */
export async function translating<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toProblem(err);
  }
}
