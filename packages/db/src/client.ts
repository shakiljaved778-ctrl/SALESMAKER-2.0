import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/prisma/client.js';

export type CellPrisma = PrismaClient;

/**
 * Create a Prisma client for a cell database. Runtime code passes the sm_app URL; only
 * migrations use sm_migrator. The connection string is never hard-coded (§3.4).
 */
export function createCellPrisma(connectionString: string): CellPrisma {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
