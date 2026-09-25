import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

import { PrismaClient } from './generated/prisma/client.js';

export type ControlPlanePrisma = PrismaClient;

const pools = new WeakMap<ControlPlanePrisma, pg.Pool>();

export function createControlPlanePrisma(
  connectionString: string,
  onPoolError: (error: Error) => void,
): ControlPlanePrisma {
  const pool = new pg.Pool({ connectionString, max: 10 });
  pool.on('error', onPoolError);
  const client = new PrismaClient({ adapter: new PrismaPg(pool) });
  pools.set(client, pool);
  return client;
}

export async function disposeControlPlanePrisma(client: ControlPlanePrisma): Promise<void> {
  await client.$disconnect();
  await pools.get(client)?.end();
  pools.delete(client);
}
