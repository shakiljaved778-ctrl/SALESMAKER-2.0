import { z } from 'zod';

/** Stable, machine-readable error codes used in problem+json `errors[].code` and `type`. */
export const ErrorCode = z
  .enum([
    'validation_failed',
    'unauthenticated',
    'forbidden',
    'not_found',
    'conflict',
    'version_conflict',
    'rate_limited',
    'idempotency_key_reused',
    'mfa_required',
    'account_locked',
    'email_not_verified',
    'internal_error',
  ])
  .meta({ id: 'ErrorCode' });
export type ErrorCode = z.infer<typeof ErrorCode>;

export const FieldError = z
  .object({
    field: z.string().describe('Dotted path of the offending field, e.g. "billing.country"'),
    code: z.string(),
    message: z.string(),
  })
  .meta({ id: 'FieldError' });

/** RFC 9457 problem details (§10.1). */
export const ProblemDetails = z
  .object({
    type: z.string().describe('URI reference identifying the problem type'),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    detail: z.string().optional(),
    instance: z.string().optional(),
    code: ErrorCode,
    errors: z.array(FieldError).optional(),
    traceId: z.string().optional(),
  })
  .meta({ id: 'ProblemDetails' });
export type ProblemDetails = z.infer<typeof ProblemDetails>;

export const PROBLEM_TYPE_BASE = 'https://developers.salesmaker.app/problems/';

export function problemType(code: ErrorCode): string {
  return `${PROBLEM_TYPE_BASE}${code.replaceAll('_', '-')}`;
}
