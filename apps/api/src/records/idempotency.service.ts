import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { TenantTransaction } from '@sm/db';
import { DomainError, errors } from '@sm/server-kit';

import { isUniqueViolation } from '../setup/common.js';

/** Keys are kept 24 h (§10.1). */
const RETENTION_MS = 24 * 3_600_000;

/**
 * `Idempotency-Key` on POST (§10.1, golden rule 10). The first response under a key is stored in
 * the same transaction as the change, so a retry replays it and a crash leaves neither. Keys are
 * scoped to the caller, and a key reused for a different request is refused (422).
 */
@Injectable()
export class IdempotencyService {
  async run<T>(
    tx: TenantTransaction,
    key: string | undefined,
    request: unknown,
    status: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (key === undefined) return fn();
    const { tenantId, userId } = tx.context;
    const scoped = `${userId ?? 'anonymous'}:${key}`;
    const hash = createHash('sha256').update(JSON.stringify(request)).digest();
    const existing = await tx.prisma.idempotencyKey.findUnique({
      where: { tenantId_key: { tenantId, key: scoped } },
    });
    if (existing && existing.expiresAt > new Date()) {
      if (!Buffer.from(existing.requestHash).equals(hash))
        throw new DomainError(
          'idempotency_key_reused',
          422,
          'This Idempotency-Key was used for a different request',
        );
      return existing.responseBody as T;
    }
    if (existing)
      await tx.prisma.idempotencyKey.delete({ where: { tenantId_key: { tenantId, key: scoped } } });
    const body = await fn();
    try {
      await tx.prisma.idempotencyKey.create({
        data: {
          tenantId,
          key: scoped,
          requestHash: hash,
          responseStatus: status,
          responseBody: body as never,
          expiresAt: new Date(Date.now() + RETENTION_MS),
        },
      });
    } catch (err) {
      // Another request with this key committed first: this one rolls back entirely.
      if (isUniqueViolation(err))
        throw errors.conflict('A request with this Idempotency-Key is in progress; retry it');
      throw err;
    }
    return body;
  }
}
