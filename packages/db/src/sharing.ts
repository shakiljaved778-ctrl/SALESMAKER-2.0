import { membership } from './membership.js';
import type { TenantTransaction } from './tenant.js';

/**
 * Who a user is, for record sharing (§6.4): the ids a share can name to reach them. Groups and
 * queues are transitive. `orgUnitId` matches shares to exactly that role; `orgUnitAndAncestors`
 * (their unit and every unit above it) matches "role and subordinates" shares.
 */
export interface Principals {
  userId: string;
  groupIds: string[];
  queueIds: string[];
  orgUnitId: string | null;
  orgUnitAndAncestors: string[];
}

export const visibility = {
  /**
   * Recompute the owner-visibility closure for the given viewers, or for every user of the
   * tenant when omitted. Returns the rows written.
   */
  async rebuild(tx: TenantTransaction, viewers?: readonly string[]): Promise<number> {
    const rows = await tx.prisma.$queryRaw<{ n: number }[]>`
      SELECT rebuild_user_visibility(${viewers ? [...viewers] : null}::uuid[]) AS n`;
    return rows[0]?.n ?? 0;
  },

  /** Owners whose records hierarchy access shows this viewer (sorted). */
  async ownersVisibleTo(tx: TenantTransaction, viewerUserId: string): Promise<string[]> {
    const rows = await tx.prisma.userVisibilityClosure.findMany({
      where: { viewerUserId },
      select: { ownerId: true },
      orderBy: { ownerId: 'asc' },
    });
    return rows.map((r) => r.ownerId);
  },

  /** Users in org units strictly above any of these units: they see those units' records. */
  async viewersAbove(tx: TenantTransaction, orgUnitIds: readonly string[]): Promise<string[]> {
    if (orgUnitIds.length === 0) return [];
    const rows = await tx.prisma.$queryRaw<{ id: string }[]>`
      SELECT users_above_org_units(${[...orgUnitIds]}::uuid[]) AS id`;
    return rows.map((r) => r.id).sort();
  },
};

/** The principal set of a user (uncached; the API caches it by permVersion). */
export async function principalsOf(tx: TenantTransaction, userId: string): Promise<Principals> {
  const user = await tx.prisma.user.findUnique({
    where: { tenantId_id: { tenantId: tx.context.tenantId, id: userId } },
    select: { orgUnitId: true },
  });
  const orgUnitId = user?.orgUnitId ?? null;
  const [groupIds, queueIds, ancestors] = await Promise.all([
    membership.userGroups(tx, userId),
    membership.userQueues(tx, userId),
    orgUnitId
      ? tx.prisma.orgUnitClosure.findMany({
          where: { descendantId: orgUnitId },
          select: { ancestorId: true },
        })
      : Promise.resolve([]),
  ]);
  return {
    userId,
    groupIds,
    queueIds,
    orgUnitId,
    orgUnitAndAncestors: ancestors.map((a) => a.ancestorId).sort(),
  };
}
