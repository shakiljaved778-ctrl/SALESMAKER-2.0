import type { LoggerService } from '@nestjs/common';
import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

import { requestContext } from './request-context.js';

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// International or local phone numbers; the (?<![\w-]) / (?![\w-]) guards keep UUIDs, request ids
// and version strings intact because those never stand alone as short digit groups.
const PHONE = /(?<![\w-])(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?![\w-])/g;

/** Mask email addresses and phone numbers in free text (§11.4: logs never contain PII values). */
export function scrubPii(text: string): string {
  return text.replace(EMAIL, '[email]').replace(PHONE, '[phone]');
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrubPii(value);
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  if (value instanceof Error) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v, depth + 1)]));
}

/** Header, cookie and body fields that must never reach a log line. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
  '*.secret',
  '*.totpCode',
  '*.recoveryCode',
];

export function createLogger(options: {
  service: string;
  level?: string;
  destination?: DestinationStream;
}): Logger {
  const config: LoggerOptions = {
    level: options.level ?? process.env['LOG_LEVEL'] ?? 'info',
    base: { service: options.service },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: {
      log(object) {
        return scrubValue(object, 0) as Record<string, unknown>;
      },
    },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((a) => (typeof a === 'string' ? scrubPii(a) : a)) as Parameters<
          typeof method
        >;
        method.apply(this, scrubbed);
      },
    },
    mixin() {
      const ctx = requestContext.get();
      return ctx ? { requestId: ctx.requestId, tenantId: ctx.tenantId, userId: ctx.userId } : {};
    },
  };
  return options.destination ? pino(config, options.destination) : pino(config);
}

/** Route NestJS framework logs through pino. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string) {
    this.logger.info({ context }, String(message));
  }

  error(message: unknown, trace?: string, context?: string) {
    this.logger.error({ context, trace }, String(message));
  }

  warn(message: unknown, context?: string) {
    this.logger.warn({ context }, String(message));
  }

  debug(message: unknown, context?: string) {
    this.logger.debug({ context }, String(message));
  }

  verbose(message: unknown, context?: string) {
    this.logger.trace({ context }, String(message));
  }
}
