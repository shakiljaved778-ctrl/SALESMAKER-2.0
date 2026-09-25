import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@sm/server-kit';

import type { Prisma } from '../generated/prisma/client.js';
import type { ControlPlanePrisma } from '../prisma.js';
import { PRISMA } from '../tokens.js';

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Idempotency-Key handling (golden rule 10): the first request with a key runs and its response
 * is stored for 24 h; a retry with the same key and body replays it; the same key with a
 * different body is refused. A transaction-scoped advisory lock serialises concurrent retries.
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(PRISMA) private readonly prisma: ControlPlanePrisma) {}

  async run<T extends Prisma.InputJsonValue>(
    scope: string,
    key: string,
    request: unknown,
    fn: (tx: Prisma.TransactionClient) => Promise<{ status: number; body: T }>,
  ): Promise<IdempotentResult<T>> {
    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest();
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope}:${key}`}, 0))`;
      const existing = await tx.idempotencyKey.findUnique({ where: { scope_key: { scope, key } } });
      if (existing && existing.expiresAt > new Date()) {
        if (!Buffer.from(existing.requestHash).equals(requestHash)) {
          throw new DomainError(
            'idempotency_key_reused',
            422,
            'This Idempotency-Key was used with a different request',
          );
        }
        return {
          status: existing.responseStatus,
          body: existing.responseBody as T,
          replayed: true,
        };
      }
      const result = await fn(tx);
      await tx.idempotencyKey.upsert({
        where: { scope_key: { scope, key } },
        create: {
          scope,
          key,
          requestHash,
          responseStatus: result.status,
          responseBody: result.body,
          expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        },
        update: {
          requestHash,
          responseStatus: result.status,
          responseBody: result.body,
          expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        },
      });
      return { ...result, replayed: false };
    });
  }
}
