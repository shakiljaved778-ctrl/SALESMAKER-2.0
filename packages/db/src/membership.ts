import type { TenantTransaction } from './tenant.js';

type Ids = { id: string }[];
const ids = (rows: Ids) => rows.map((r) => r.id).sort();

/**
 * Transitive membership (§6.3, §6.4), expanded by the SQL functions from migration 0007 inside
 * the caller's tenant transaction: nested public groups, org units and org-unit subtrees all
 * resolve to users. Results are sorted for stable caching and comparison.
 */
export const membership = {
  /** Users a public group contains. */
  async groupUsers(tx: TenantTransaction, groupId: string): Promise<string[]> {
    return ids(await tx.prisma.$queryRaw<Ids>`SELECT group_user_ids(${groupId}::uuid) AS id`);
  },
  /** Public groups a user belongs to, including every group that contains one of them. */
  async userGroups(tx: TenantTransaction, userId: string): Promise<string[]> {
    return ids(await tx.prisma.$queryRaw<Ids>`SELECT user_public_group_ids(${userId}::uuid) AS id`);
  },
  /** Users a queue contains. */
  async queueUsers(tx: TenantTransaction, queueId: string): Promise<string[]> {
    return ids(await tx.prisma.$queryRaw<Ids>`SELECT queue_user_ids(${queueId}::uuid) AS id`);
  },
  /** Queues a user belongs to. */
  async userQueues(tx: TenantTransaction, userId: string): Promise<string[]> {
    return ids(await tx.prisma.$queryRaw<Ids>`SELECT user_queue_ids(${userId}::uuid) AS id`);
  },
};
