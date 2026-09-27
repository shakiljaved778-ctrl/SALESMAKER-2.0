import { audit, type TenantTransaction } from '@sm/db';
import { objectAccess } from '@sm/permissions';
import { sharingPredicate } from '@sm/query-engine';
import { sql } from 'kysely';

import type { RecordContext } from './context.js';
import { RecordError } from './errors.js';
import { syncAccountShares, syncOpportunityShares } from './shares.js';

/** Objects with record teams (§6.3). */
export type TeamObject = 'account' | 'opportunity';

export interface TeamMemberInput {
  userId: string;
  role?: string | null;
  /** 1 read, 2 read-write on the record. */
  access: 1 | 2;
  /** Account teams only: access to the account's opportunities (0 none, 1 read, 2 read-write). */
  opportunityAccess?: 0 | 1 | 2;
}

export interface TeamMember {
  id: string;
  userId: string;
  role: string | null;
  access: number;
  opportunityAccess: number | null;
}

/**
 * Changing a team shares the record, which needs Full access (§6.2: owner-equivalent: transfer,
 * share, delete). A record the user cannot read is not found.
 */
async function requireFull(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: TeamObject,
  id: string,
) {
  if (!ctx.metadata.object(object) || !objectAccess(ctx.permissions, object).read)
    throw new RecordError('not_found');
  const reach = async (level: 'read' | 'full') =>
    (
      await sql`SELECT 1 FROM ${sql.table(object)} AS r
        WHERE r.tenant_id = ${tx.context.tenantId}::uuid AND r.id = ${id}::uuid AND r.deleted_at IS NULL
          AND ${sharingPredicate(ctx.sharing, object, 'r', level)}`.execute(tx.kysely)
    ).rows.length > 0;
  if (!(await reach('read'))) throw new RecordError('not_found');
  if (!(await reach('full')))
    throw new RecordError('forbidden', [{ field: '_record', code: 'team_not_allowed' }]);
}

async function resync(tx: TenantTransaction, object: TeamObject, id: string) {
  if (object === 'account') await syncAccountShares(tx, [id], { children: true });
  else await syncOpportunityShares(tx, [id]);
}

/** A record's team, for whoever can read the record. */
export async function listTeam(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: TeamObject,
  id: string,
): Promise<TeamMember[]> {
  if (!ctx.metadata.object(object) || !objectAccess(ctx.permissions, object).read)
    throw new RecordError('not_found');
  const visible = await sql`SELECT 1 FROM ${sql.table(object)} AS r
    WHERE r.tenant_id = ${tx.context.tenantId}::uuid AND r.id = ${id}::uuid AND r.deleted_at IS NULL
      AND ${sharingPredicate(ctx.sharing, object, 'r', 'read')}`.execute(tx.kysely);
  if (visible.rows.length === 0) throw new RecordError('not_found');
  if (object === 'account') {
    const rows = await tx.prisma.accountTeamMember.findMany({
      where: { accountId: id },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      role: r.role,
      access: r.access,
      opportunityAccess: r.opportunityAccess,
    }));
  }
  const rows = await tx.prisma.opportunityTeamMember.findMany({
    where: { opportunityId: id },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    role: r.role,
    access: r.access,
    opportunityAccess: null,
  }));
}

/** Add a member to a record's team, or change their role and access. */
export async function setTeamMember(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: TeamObject,
  id: string,
  input: TeamMemberInput,
): Promise<void> {
  await requireFull(tx, ctx, object, id);
  const invalid = (field: string, code: string) => new RecordError('invalid', [{ field, code }]);
  if (![1, 2].includes(input.access)) throw invalid('access', 'invalid_access');
  if (object === 'opportunity' && input.opportunityAccess !== undefined)
    throw invalid('opportunityAccess', 'not_applicable');
  const oppAccess = input.opportunityAccess ?? 0;
  if (![0, 1, 2].includes(oppAccess)) throw invalid('opportunityAccess', 'invalid_access');
  const user = await tx.prisma.user.findFirst({
    where: { id: input.userId, status: 'ACTIVE', deactivatedAt: null, deletedAt: null },
  });
  if (!user) throw invalid('userId', 'invalid_reference');
  const tenantId = tx.context.tenantId;
  const role = input.role ?? null;
  if (object === 'account')
    await tx.prisma.accountTeamMember.upsert({
      where: { tenantId_accountId_userId: { tenantId, accountId: id, userId: input.userId } },
      create: {
        tenantId,
        accountId: id,
        userId: input.userId,
        role,
        access: input.access,
        opportunityAccess: oppAccess,
        createdBy: ctx.userId,
      },
      update: { role, access: input.access, opportunityAccess: oppAccess },
    });
  else
    await tx.prisma.opportunityTeamMember.upsert({
      where: {
        tenantId_opportunityId_userId: { tenantId, opportunityId: id, userId: input.userId },
      },
      create: {
        tenantId,
        opportunityId: id,
        userId: input.userId,
        role,
        access: input.access,
        createdBy: ctx.userId,
      },
      update: { role, access: input.access },
    });
  await resync(tx, object, id);
  await audit.record(tx, {
    action: 'record.team_member_set',
    object,
    recordId: id,
    payload: { userId: input.userId, access: input.access, opportunityAccess: oppAccess },
    ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
  });
}

/** Remove a member from a record's team (their team shares go with them). */
export async function removeTeamMember(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: TeamObject,
  id: string,
  userId: string,
): Promise<void> {
  await requireFull(tx, ctx, object, id);
  const removed =
    object === 'account'
      ? await tx.prisma.accountTeamMember.deleteMany({ where: { accountId: id, userId } })
      : await tx.prisma.opportunityTeamMember.deleteMany({ where: { opportunityId: id, userId } });
  if (removed.count === 0) throw new RecordError('not_found');
  await resync(tx, object, id);
  await audit.record(tx, {
    action: 'record.team_member_removed',
    object,
    recordId: id,
    payload: { userId },
    ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
  });
}
