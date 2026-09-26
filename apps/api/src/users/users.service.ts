import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { InviteUserRequest, UpdateUserRequest, UserListQuery } from '@sm/contracts';
import {
  audit,
  outbox,
  visibility,
  withTenant,
  type CellPrisma,
  type TenantTransaction,
} from '@sm/db';
import { DomainError, errors } from '@sm/server-kit';
import type { z } from 'zod';

import { AuthEmailService } from '../auth/auth-email.service.js';
import type { ClientInfo, LoginResult } from '../auth/auth.service.js';
import { AuthService } from '../auth/auth.service.js';
import { LoginHistoryService } from '../auth/login-history.service.js';
import { PasswordService } from '../auth/password.service.js';
import { SessionService } from '../auth/session.service.js';
import { PRISMA } from '../tokens.js';

export const INVITATION_TTL_DAYS = 7;

const sha256 = (value: string) => new Uint8Array(createHash('sha256').update(value).digest());

const expiredLink = () =>
  new DomainError('validation_failed', 400, 'This invitation has expired or was already used', [
    { field: 'token', code: 'invalid', message: 'This invitation has expired or was already used' },
  ]);

const invalidReference = (field: string) =>
  errors.validation([{ field, code: 'not_found', message: `No such ${field.replace(/Id$/, '')}` }]);

type UserDetail = Awaited<ReturnType<UsersService['detail']>>;

const USER_INCLUDE = {
  profile: { select: { id: true, name: true } },
  orgUnit: { select: { id: true, name: true } },
  manager: { select: { id: true, name: true } },
} as const;

type UserRow = {
  id: string;
  email: string;
  name: string;
  status: 'PENDING' | 'ACTIVE' | 'DISABLED';
  deactivatedAt: Date | null;
  title: string | null;
  department: string | null;
  phone: string | null;
  createdAt: Date;
  version: number;
  profile: { id: string; name: string } | null;
  orgUnit: { id: string; name: string } | null;
  manager: { id: string; name: string } | null;
};

function summary(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    status: u.status,
    deactivated: u.deactivatedAt !== null,
    title: u.title,
    department: u.department,
    phone: u.phone,
    profile: u.profile,
    orgUnit: u.orgUnit,
    manager: u.manager,
    createdAt: u.createdAt.toISOString(),
    version: u.version,
  };
}

function encodeCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify([name, id])).toString('base64url');
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(value) && typeof value[0] === 'string' && typeof value[1] === 'string')
      return [value[0], value[1]];
  } catch {
    // fall through
  }
  throw errors.validation([{ field: 'cursor', code: 'invalid', message: 'Invalid cursor' }]);
}

/**
 * Users and invitations (§6.1, P01 plan §3.4). Every change runs in the caller's tenant
 * transaction, keeps owner visibility and rule shares current, and writes the Setup audit trail.
 */
@Injectable()
export class UsersService {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly auth: AuthService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly mail: AuthEmailService,
    private readonly history: LoginHistoryService,
  ) {}

  async list(tx: TenantTransaction, q: z.infer<typeof UserListQuery>) {
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await tx.prisma.user.findMany({
      where: {
        deletedAt: null,
        ...(q.q
          ? {
              OR: [
                { name: { contains: q.q, mode: 'insensitive' as const } },
                { email: { contains: q.q } },
              ],
            }
          : {}),
        ...(q.status === 'DEACTIVATED'
          ? { deactivatedAt: { not: null } }
          : q.status
            ? { status: q.status, deactivatedAt: null }
            : {}),
        ...(q.profileId ? { profileId: q.profileId } : {}),
        ...(q.orgUnitId ? { orgUnitId: q.orgUnitId } : {}),
        ...(after
          ? { OR: [{ name: { gt: after[0] } }, { name: after[0], id: { gt: after[1] } }] }
          : {}),
      },
      include: USER_INCLUDE,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map(summary),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.name, last.id) : null,
    };
  }

  async detail(tx: TenantTransaction, userId: string) {
    const user = await tx.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: {
        ...USER_INCLUDE,
        permissionAssignments: {
          select: {
            permissionSet: { select: { id: true, name: true } },
            permissionSetGroup: { select: { id: true, name: true } },
          },
        },
        invitations: {
          where: { acceptedAt: null, revokedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
    if (!user) throw errors.notFound('User');
    const invitation = user.invitations[0];
    return {
      ...summary(user),
      permissionSets: user.permissionAssignments.flatMap((a) =>
        a.permissionSet ? [a.permissionSet] : [],
      ),
      permissionSetGroups: user.permissionAssignments.flatMap((a) =>
        a.permissionSetGroup ? [a.permissionSetGroup] : [],
      ),
      invitation: invitation
        ? {
            id: invitation.id,
            sentAt: invitation.createdAt.toISOString(),
            expiresAt: invitation.expiresAt.toISOString(),
            expired: invitation.expiresAt <= new Date(),
          }
        : null,
    };
  }

  /** Check that referenced profile, org unit and manager exist in this workspace. */
  private async assertReferences(
    tx: TenantTransaction,
    refs: {
      profileId?: string | undefined;
      orgUnitId?: string | null | undefined;
      managerId?: string | null | undefined;
    },
  ): Promise<void> {
    const { prisma } = tx;
    if (
      refs.profileId &&
      !(await prisma.profile.findFirst({ where: { id: refs.profileId, deletedAt: null } }))
    )
      throw invalidReference('profileId');
    if (
      refs.orgUnitId &&
      !(await prisma.orgUnit.findFirst({ where: { id: refs.orgUnitId, deletedAt: null } }))
    )
      throw invalidReference('orgUnitId');
    if (
      refs.managerId &&
      !(await prisma.user.findFirst({ where: { id: refs.managerId, deletedAt: null } }))
    )
      throw invalidReference('managerId');
  }

  /**
   * After a user's placement changes, rebuild the owner visibility of everyone it affects: the
   * user, their old and new managers, and users above their old and new org units (§6.4). Owner-based
   * sharing rules may now match different owners, so they are recalculated in the background.
   */
  private async placementChanged(
    tx: TenantTransaction,
    userId: string,
    before: { orgUnitId: string | null; managerId: string | null },
    after: { orgUnitId: string | null; managerId: string | null },
  ): Promise<void> {
    const units = [before.orgUnitId, after.orgUnitId].filter((u): u is string => u !== null);
    const viewers = new Set([
      userId,
      ...[before.managerId, after.managerId].filter((m): m is string => m !== null),
      ...(await visibility.viewersAbove(tx, units)),
    ]);
    await visibility.rebuild(tx, [...viewers]);
    if (before.orgUnitId !== after.orgUnitId) {
      const rules = await tx.prisma.sharingRule.findMany({
        where: { kind: 'OWNER', active: true },
        select: { id: true },
      });
      await outbox.emit(
        tx,
        rules.map((r) => ({ topic: 'sharing.rule_changed', payload: { ruleId: r.id } })),
      );
    }
  }

  private async issueInvitation(tx: TenantTransaction, userId: string): Promise<string> {
    await tx.prisma.invitation.updateMany({
      where: { userId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const token = randomBytes(32).toString('base64url');
    await tx.prisma.invitation.create({
      data: {
        tenantId: tx.context.tenantId,
        userId,
        tokenHash: sha256(token),
        invitedBy: tx.context.userId ?? null,
        expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000),
      },
    });
    return token;
  }

  private async sendInvitation(tenantId: string, inviterId: string, userId: string, token: string) {
    const { workspace, inviter, user } = await withTenant(
      this.prisma,
      { tenantId },
      async ({ prisma }) => ({
        workspace: await prisma.tenantSettings.findUniqueOrThrow({
          where: { tenantId },
          select: { name: true, slug: true, defaultLocale: true },
        }),
        inviter: await prisma.user.findUnique({
          where: { tenantId_id: { tenantId, id: inviterId } },
          select: { name: true },
        }),
        user: await prisma.user.findUniqueOrThrow({
          where: { tenantId_id: { tenantId, id: userId } },
          select: { email: true, name: true, locale: true },
        }),
      }),
    );
    await this.mail.sendInvitation(
      { email: user.email, name: user.name, locale: user.locale ?? workspace.defaultLocale },
      workspace,
      inviter?.name ?? workspace.name,
      token,
      INVITATION_TTL_DAYS,
    );
  }

  /** Invite a person: a PENDING user, a 7-day single-use token, and the email (after commit). */
  async invite(
    tenantId: string,
    actorId: string,
    input: z.infer<typeof InviteUserRequest>,
  ): Promise<UserDetail> {
    const { userId, token, detail } = await withTenant(
      this.prisma,
      { tenantId, userId: actorId },
      async (tx) => {
        const email = input.email.toLowerCase();
        if (await tx.prisma.user.findFirst({ where: { email } }))
          throw errors.conflict('That email already belongs to a user of this workspace');
        await this.assertReferences(tx, input);
        const user = await tx.prisma.user.create({
          data: {
            tenantId,
            email,
            name: input.name,
            status: 'PENDING',
            profileId: input.profileId,
            orgUnitId: input.orgUnitId ?? null,
            managerId: input.managerId ?? null,
            title: input.title ?? null,
            locale: input.locale ?? null,
            createdBy: actorId,
            updatedBy: actorId,
          },
        });
        await this.placementChanged(
          tx,
          user.id,
          { orgUnitId: null, managerId: null },
          { orgUnitId: user.orgUnitId, managerId: user.managerId },
        );
        const token = await this.issueInvitation(tx, user.id);
        const detail = await this.detail(tx, user.id);
        await audit.setup(tx, {
          action: 'user.invited',
          entityType: 'user',
          entityId: user.id,
          entityName: user.name,
          after: { email, name: user.name, profileId: input.profileId },
        });
        await audit.record(tx, { action: 'user.invited', recordId: user.id });
        return { userId: user.id, token, detail };
      },
    );
    await this.sendInvitation(tenantId, actorId, userId, token);
    return detail;
  }

  async resendInvitation(tenantId: string, actorId: string, userId: string): Promise<UserDetail> {
    const { token, detail } = await withTenant(
      this.prisma,
      { tenantId, userId: actorId },
      async (tx) => {
        const user = await tx.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
        if (!user) throw errors.notFound('User');
        if (user.status !== 'PENDING') throw errors.conflict('This user has already accepted');
        const token = await this.issueInvitation(tx, userId);
        await audit.setup(tx, {
          action: 'user.invitation_resent',
          entityType: 'user',
          entityId: userId,
          entityName: user.name,
        });
        return { token, detail: await this.detail(tx, userId) };
      },
    );
    await this.sendInvitation(tenantId, actorId, userId, token);
    return detail;
  }

  /** Withdraw an invitation. The pending user never signed in and owns nothing: it is removed. */
  async revokeInvitation(tx: TenantTransaction, userId: string): Promise<void> {
    const user = await tx.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!user) throw errors.notFound('User');
    if (user.status !== 'PENDING') throw errors.conflict('This user has already accepted');
    if (await tx.prisma.user.count({ where: { managerId: userId } }))
      throw errors.conflict('Other users report to this person; change their manager first');
    const viewers = await visibility.viewersAbove(tx, user.orgUnitId ? [user.orgUnitId] : []);
    await tx.prisma.user.delete({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id: userId } },
    });
    await visibility.rebuild(tx, [userId, ...viewers, ...(user.managerId ? [user.managerId] : [])]);
    await audit.setup(tx, {
      action: 'user.invitation_revoked',
      entityType: 'user',
      entityId: userId,
      entityName: user.name,
      before: { email: user.email, name: user.name },
    });
  }

  /** Accept an invitation with a password (single use), and sign the new user in. */
  async acceptInvitation(
    tenantId: string,
    input: { token: string; password: string; name?: string | undefined },
    client: ClientInfo,
  ): Promise<LoginResult> {
    await this.auth.assertTenant(tenantId);
    const tokenHash = sha256(input.token);
    const found = await withTenant(this.prisma, { tenantId }, ({ prisma }) =>
      prisma.invitation.findFirst({ where: { tokenHash }, include: { user: true } }),
    );
    if (
      !found ||
      found.acceptedAt ||
      found.revokedAt ||
      found.expiresAt <= new Date() ||
      found.user.status !== 'PENDING' ||
      found.user.deletedAt
    )
      throw expiredLink();
    const passwordHash = await this.passwords.hashNew(input.password);
    return withTenant(this.prisma, { tenantId, userId: found.userId }, async (tx) => {
      // Consume the token atomically: a concurrent second use finds nothing left to accept.
      const consumed = await tx.prisma.invitation.updateMany({
        where: { id: found.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: new Date() },
      });
      if (consumed.count !== 1) throw expiredLink();
      await tx.prisma.userIdentity.create({
        data: {
          tenantId,
          userId: found.userId,
          provider: 'password',
          subject: found.user.email,
          passwordHash,
        },
      });
      await tx.prisma.user.update({
        where: { tenantId_id: { tenantId, id: found.userId } },
        data: {
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
          ...(input.name ? { name: input.name } : {}),
          version: { increment: 1 },
        },
      });
      await audit.record(tx, { action: 'user.invitation_accepted', recordId: found.userId });
      const { sessionId, tokens } = await this.sessions.startWithId(
        tx,
        found.userId,
        ['pwd'],
        client,
      );
      await this.history.recordIn(tx, {
        method: 'password',
        outcome: 'SUCCESS',
        userId: found.userId,
        sessionId,
        client,
      });
      return { status: 'ok' as const, tokens, user: await this.auth.me(tx, found.userId) };
    });
  }

  async update(
    tx: TenantTransaction,
    userId: string,
    input: z.infer<typeof UpdateUserRequest>,
  ): Promise<UserDetail> {
    const before = await tx.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!before) throw errors.notFound('User');
    await this.assertReferences(tx, input);
    const { version, ...changes } = input;
    let updated;
    try {
      updated = await tx.prisma.user.updateMany({
        where: { id: userId, version },
        data: { ...changes, version: { increment: 1 }, updatedBy: tx.context.userId ?? null },
      });
    } catch (err) {
      if (err instanceof Error && /own report|user_not_own_manager/.test(err.message))
        throw errors.conflict('That manager reports to this user');
      throw err;
    }
    if (updated.count !== 1)
      throw new DomainError(
        'version_conflict',
        409,
        'Someone else changed this user; reload and try again',
      );
    const after = {
      orgUnitId: input.orgUnitId === undefined ? before.orgUnitId : input.orgUnitId,
      managerId: input.managerId === undefined ? before.managerId : input.managerId,
    };
    if (after.orgUnitId !== before.orgUnitId || after.managerId !== before.managerId)
      await this.placementChanged(tx, userId, before, after);
    const beforeFields = Object.fromEntries(
      Object.keys(changes).map((k) => [k, (before as Record<string, unknown>)[k] ?? null]),
    );
    await audit.setup(tx, {
      action: 'user.updated',
      entityType: 'user',
      entityId: userId,
      entityName: before.name,
      before: beforeFields,
      after: changes,
    });
    return this.detail(tx, userId);
  }

  async setAssignments(
    tx: TenantTransaction,
    userId: string,
    input: { permissionSetIds: string[]; permissionSetGroupIds: string[] },
  ): Promise<UserDetail> {
    const before = await this.detail(tx, userId);
    const sets = [...new Set(input.permissionSetIds)];
    const groups = [...new Set(input.permissionSetGroupIds)];
    const validSets = await tx.prisma.permissionSet.count({
      where: { id: { in: sets }, kind: 'STANDARD', deletedAt: null },
    });
    if (validSets !== sets.length) throw invalidReference('permissionSetIds');
    const validGroups = await tx.prisma.permissionSetGroup.count({
      where: { id: { in: groups }, deletedAt: null },
    });
    if (validGroups !== groups.length) throw invalidReference('permissionSetGroupIds');
    const { tenantId } = tx.context;
    await tx.prisma.permissionAssignment.deleteMany({ where: { userId } });
    await tx.prisma.permissionAssignment.createMany({
      data: [
        ...sets.map((permissionSetId) => ({ tenantId, userId, permissionSetId })),
        ...groups.map((permissionSetGroupId) => ({ tenantId, userId, permissionSetGroupId })),
      ],
    });
    const after = await this.detail(tx, userId);
    await audit.setup(tx, {
      action: 'user.assignments_changed',
      entityType: 'user',
      entityId: userId,
      entityName: before.name,
      before: {
        permissionSets: before.permissionSets,
        permissionSetGroups: before.permissionSetGroups,
      },
      after: {
        permissionSets: after.permissionSets,
        permissionSetGroups: after.permissionSetGroups,
      },
    });
    return after;
  }

  /** Deactivate: cannot sign in, every session ends at once; records and history stay (§6.1). */
  async deactivate(tx: TenantTransaction, userId: string): Promise<UserDetail> {
    const user = await tx.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!user) throw errors.notFound('User');
    if (userId === tx.context.userId) throw errors.conflict('You cannot deactivate yourself');
    const settings = await tx.prisma.tenantSettings.findUniqueOrThrow({
      where: { tenantId: tx.context.tenantId },
      select: { ownerUserId: true },
    });
    if (settings.ownerUserId === userId)
      throw errors.conflict('The workspace owner cannot be deactivated');
    if (user.status === 'PENDING') throw errors.conflict('Withdraw the invitation instead');
    if (!user.deactivatedAt) {
      await tx.prisma.user.update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id: userId } },
        data: {
          deactivatedAt: new Date(),
          version: { increment: 1 },
          updatedBy: tx.context.userId ?? null,
        },
      });
      const ended = await this.sessions.revokeAllForUser(tx, userId);
      await audit.setup(tx, {
        action: 'user.deactivated',
        entityType: 'user',
        entityId: userId,
        entityName: user.name,
        after: { sessionsEnded: ended },
      });
      await audit.record(tx, { action: 'user.deactivated', recordId: userId });
    }
    return this.detail(tx, userId);
  }

  async reactivate(tx: TenantTransaction, userId: string): Promise<UserDetail> {
    const user = await tx.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!user) throw errors.notFound('User');
    if (user.deactivatedAt) {
      await tx.prisma.user.update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id: userId } },
        data: {
          deactivatedAt: null,
          version: { increment: 1 },
          updatedBy: tx.context.userId ?? null,
        },
      });
      await audit.setup(tx, {
        action: 'user.reactivated',
        entityType: 'user',
        entityId: userId,
        entityName: user.name,
      });
      await audit.record(tx, { action: 'user.reactivated', recordId: userId });
    }
    return this.detail(tx, userId);
  }
}
