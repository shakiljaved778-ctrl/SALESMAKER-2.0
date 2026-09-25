import { describe, expect, it } from 'vitest';

import { DomainError, errors } from '../src/index.js';

describe('errors helpers', () => {
  it('build DomainErrors with the §10.1 codes and statuses', () => {
    const cases: [DomainError, string, number, string][] = [
      [errors.notFound(), 'not_found', 404, 'Resource not found'],
      [errors.notFound('Account'), 'not_found', 404, 'Account not found'],
      [errors.unauthenticated(), 'unauthenticated', 401, 'Sign in to continue'],
      [errors.forbidden(), 'forbidden', 403, 'You do not have access to this action'],
      [errors.conflict('Taken'), 'conflict', 409, 'Taken'],
      [
        errors.validation([{ field: 'name', code: 'too_small', message: 'Required' }]),
        'validation_failed',
        400,
        'Some fields need attention',
      ],
    ];
    for (const [error, code, status, message] of cases) {
      expect(error).toBeInstanceOf(DomainError);
      expect({ code: error.code, status: error.status, message: error.message }).toEqual({
        code,
        status,
        message,
      });
    }
    expect(errors.validation([], 'Bad').fieldErrors).toEqual([]);
  });
});
