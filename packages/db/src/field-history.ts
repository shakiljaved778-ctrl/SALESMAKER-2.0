import type { TenantTransaction } from './tenant.js';

/** Field history (§7.17): monthly partitions, kept ahead by the worker's maintenance job. */
export const fieldHistory = {
  async maintainPartitions(prisma: {
    $queryRaw: TenantTransaction['prisma']['$queryRaw'];
  }): Promise<string[]> {
    const [row] = await prisma.$queryRaw<
      { made: string[] }[]
    >`SELECT field_history_maintain_partitions() AS made`;
    return row?.made ?? [];
  },
};
