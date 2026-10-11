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

/** The append-only logs partitioned by month from P03 on (assignment log, score history). */
export const MONTHLY_LOGS = ['assignment_log', 'score_history'] as const;

/** Keeps their monthly partitions ahead (one SQL function for all of them). */
export const monthlyLogs = {
  async maintainPartitions(prisma: {
    $queryRaw: TenantTransaction['prisma']['$queryRaw'];
  }): Promise<string[]> {
    const made: string[] = [];
    for (const parent of MONTHLY_LOGS) {
      const [row] = await prisma.$queryRaw<
        { made: string[] }[]
      >`SELECT maintain_monthly_partitions(${parent}) AS made`;
      made.push(...(row?.made ?? []));
    }
    return made;
  },
};
