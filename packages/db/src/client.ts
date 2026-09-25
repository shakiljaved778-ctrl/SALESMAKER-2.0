import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

import { PrismaClient } from './generated/prisma/client.js';

export type CellPrisma = PrismaClient;

export interface CellPrismaOptions {
  /** Called for every SQL statement sent to Postgres (feeds OTel `db.statement.count`). */
  onStatement?: () => void;
  /**
   * Called when an idle pooled connection dies (failover, admin termination). Without a
   * listener, pg would crash the process on such an error.
   */
  onPoolError?: (error: Error) => void;
  /** Pool size per process; PgBouncer multiplexes these onto server connections. */
  maxConnections?: number;
}

/**
 * Create a Prisma client for a cell database. Runtime code passes the sm_app URL; only
 * migrations use sm_migrator. The connection string is never hard-coded (§3.4).
 */
export function createCellPrisma(
  connectionString: string,
  options: CellPrismaOptions = {},
): CellPrisma {
  const pool = new pg.Pool({ connectionString, max: options.maxConnections ?? 10 });
  pool.on('error', (error) => options.onPoolError?.(error));
  const { onStatement } = options;
  if (onStatement) {
    pool.on('connect', (client) => {
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
        onStatement();
        return query(...args);
      };
    });
  }
  const client = new PrismaClient({ adapter: new PrismaPg(pool) });
  pools.set(client, pool);
  return client;
}

const pools = new WeakMap<CellPrisma, pg.Pool>();

/** Disconnect Prisma and end the connection pool it was given (Prisma does not end it). */
export async function disposeCellPrisma(client: CellPrisma): Promise<void> {
  await client.$disconnect();
  await pools.get(client)?.end();
  pools.delete(client);
}
