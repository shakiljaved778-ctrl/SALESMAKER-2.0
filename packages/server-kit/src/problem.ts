import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { problemType, type ErrorCode, type ProblemDetails } from '@sm/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { ZodError } from 'zod';

interface FieldError {
  field: string;
  code: string;
  message: string;
}

/** An expected failure with a stable code (§10.1). Anything else becomes a 500. */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    readonly fieldErrors?: FieldError[],
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const errors = {
  notFound: (what = 'Resource') => new DomainError('not_found', 404, `${what} not found`),
  unauthenticated: (message = 'Sign in to continue') =>
    new DomainError('unauthenticated', 401, message),
  forbidden: (message = 'You do not have access to this action') =>
    new DomainError('forbidden', 403, message),
  conflict: (message: string) => new DomainError('conflict', 409, message),
  validation: (fieldErrors: FieldError[], message = 'Some fields need attention') =>
    new DomainError('validation_failed', 400, message, fieldErrors),
};

const STATUS_CODE: Record<number, ErrorCode> = {
  400: 'validation_failed',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
};

const TITLE: Partial<Record<ErrorCode, string>> = {
  validation_failed: 'Validation failed',
  unauthenticated: 'Not authenticated',
  forbidden: 'Forbidden',
  not_found: 'Not found',
  conflict: 'Conflict',
  version_conflict: 'Version conflict',
  rate_limited: 'Too many requests',
  internal_error: 'Internal error',
};

function fieldErrorsFromZod(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '(root)',
    code: issue.code,
    message: issue.message,
  }));
}

/**
 * Global exception filter: every error leaves the API as RFC 9457 problem+json (§3.6) with the
 * request id as `traceId`. Unexpected errors are logged in full but never leak detail to callers.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const problem = this.toProblem(exception, request);
    if (exception instanceof DomainError && exception.headers)
      void reply.headers(exception.headers);
    void reply
      .status(problem.status)
      .header('content-type', 'application/problem+json')
      .send(problem);
  }

  private toProblem(exception: unknown, request: FastifyRequest): ProblemDetails {
    const base = { instance: request.url.split('?')[0] ?? request.url, traceId: request.id };
    if (exception instanceof DomainError) {
      return {
        type: problemType(exception.code),
        title: TITLE[exception.code] ?? exception.code,
        status: exception.status,
        code: exception.code,
        detail: exception.message,
        ...(exception.fieldErrors ? { errors: exception.fieldErrors } : {}),
        ...base,
      };
    }
    if (exception instanceof ZodError) {
      return {
        type: problemType('validation_failed'),
        title: 'Validation failed',
        status: 400,
        code: 'validation_failed',
        detail: 'Some fields need attention',
        errors: fieldErrorsFromZod(exception),
        ...base,
      };
    }
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : typeof (exception as { statusCode?: unknown }).statusCode === 'number'
          ? (exception as { statusCode: number }).statusCode
          : 500;
    if (status >= 500) {
      this.logger.error({ err: exception }, 'Unhandled error');
      return {
        type: problemType('internal_error'),
        title: 'Internal error',
        status: 500,
        code: 'internal_error',
        ...base,
      };
    }
    const code = STATUS_CODE[status] ?? 'validation_failed';
    const detail =
      exception instanceof HttpException ? exception.message : (exception as Error).message;
    return {
      type: problemType(code),
      title: TITLE[code] ?? 'Request failed',
      status,
      code,
      detail,
      ...base,
    };
  }
}
