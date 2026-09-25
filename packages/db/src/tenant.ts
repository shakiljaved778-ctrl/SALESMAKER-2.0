import type { Kysely } from 'kysely';

import type { CellPrisma } from './client.js';
import type { Prisma } from './generated/prisma/client.js';
import { kyselyForTransaction, type DynamicDatabase } from './kysely-bridge.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Who is acting. The API derives it from the verified token and the cell, never from input. */
export interface TenantContext {
  tenantId: string;
  userId?: string | undefined;
}

export interface WithTenantOptions {
  /** Statement timeout inside the transaction: 5 s interactive, 60 s async (§3.8). */
  statementTimeoutMs?: number;
  /** Maximum transaction duration enforced by Prisma. */
  timeoutMs?: number;
}

/** Both query tools, bound to one tenant-scoped transaction on one connection. */
export interface TenantTransaction {
  prisma: Prisma.TransactionClient;
  kysely: Kysely<DynamicDatabase>;
  context: Readonly<TenantContext>;
}

export class InvalidTenantContextError extends Error {
  constructor(field: string) {
    super(`TenantContext.${field} must be a UUID`);
    this.name = 'InvalidTenantContextError';
  }
}

/**
 * Golden rule 1: the only way to touch tenant tables. Opens an interactive transaction, sets
 * the transaction-local `app.tenant_id` and `app.user_id` (so forced RLS scopes every statement,
 * and PgBouncer transaction pooling cannot leak them to another client), then runs `fn` with a
 * Prisma client and a Kysely instance that share that transaction.
 */
export async function withTenant<T>(
  prisma: CellPrisma,
  context: TenantContext,
  fn: (tx: TenantTransaction) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  if (!UUID.test(context.tenantId)) throw new InvalidTenantContextError('tenantId');
  if (context.userId !== undefined && !UUID.test(context.userId)) {
    throw new InvalidTenantContextError('userId');
  }
  const statementTimeout = `${String(options.statementTimeoutMs ?? 5_000)}ms`;
  const frozen = Object.freeze({ ...context });

  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT
        set_config('app.tenant_id', ${context.tenantId}, true),
        set_config('app.user_id', ${context.userId ?? ''}, true),
        set_config('statement_timeout', ${statementTimeout}, true)`;
      return fn({ prisma: tx, kysely: kyselyForTransaction(tx), context: frozen });
    },
    { timeout: options.timeoutMs ?? 10_000, maxWait: 5_000 },
  );
}
