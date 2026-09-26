import { Injectable } from '@nestjs/common';
import type {
  CreateGroupRequest,
  CreateQueueRequest,
  MemberDto,
  PublicGroupDto,
  QueueDto,
  UpdateGroupRequest,
  UpdateQueueRequest,
} from '@sm/contracts';
import { audit, membership, visibility, type TenantTransaction } from '@sm/db';
import { isStandardObject } from '@sm/metadata';
import { errors } from '@sm/server-kit';
import type { z } from 'zod';

import {
  assertVersion,
  invalid,
  nameTaken,
  recalculateOwnerRules,
  rethrowConflict,
} from './common.js';

type Member = z.infer<typeof MemberDto>;
type MemberInput = { type: Member['type']; id: string };
type PublicGroup = z.infer<typeof PublicGroupDto>;
type Queue = z.infer<typeof QueueDto>;

const MEMBER_SELECT = {
  memberType: true,
  userId: true,
  memberGroupId: true,
  orgUnitId: true,
  user: { select: { name: true } },
  memberGroup: { select: { name: true } },
  orgUnit: { select: { name: true } },
} as const;

interface MemberRow {
  memberType: Member['type'];
  userId: string | null;
  memberGroupId: string | null;
  orgUnitId: string | null;
  user: { name: string } | null;
  memberGroup: { name: string } | null;
  orgUnit: { name: string } | null;
}

function memberDto(m: MemberRow): Member {
  const id = m.userId ?? m.memberGroupId ?? m.orgUnitId ?? '';
  const name = m.user?.name ?? m.memberGroup?.name ?? m.orgUnit?.name ?? '';
  return { type: m.memberType, id, name };
}

const TYPE_ORDER: Record<Member['type'], number> = {
  USER: 0,
  GROUP: 1,
  ORG_UNIT: 2,
  ORG_UNIT_AND_SUBORDINATES: 3,
};
const byTypeThenName = (a: Member, b: Member) =>
  TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
  a.name.localeCompare(b.name) ||
  a.id.localeCompare(b.id);

/** Validate members exist in this workspace and turn them into member columns (deduplicated). */
async function memberRows(tx: TenantTransaction, members: readonly MemberInput[]) {
  const unique = [...new Map(members.map((m) => [`${m.type}:${m.id}`, m])).values()];
  const ids = (type: Member['type'] | Member['type'][]) =>
    unique.filter((m) => (Array.isArray(type) ? type : [type]).includes(m.type)).map((m) => m.id);
  const users = ids('USER');
  const groups = ids('GROUP');
  const units = [...new Set(ids(['ORG_UNIT', 'ORG_UNIT_AND_SUBORDINATES']))];
  const [u, g, o] = await Promise.all([
    tx.prisma.user.count({ where: { id: { in: users }, deletedAt: null } }),
    tx.prisma.publicGroup.count({ where: { id: { in: groups }, deletedAt: null } }),
    tx.prisma.orgUnit.count({ where: { id: { in: units }, deletedAt: null } }),
  ]);
  if (u !== users.length || g !== groups.length || o !== units.length)
    throw invalid('members', 'Some members do not exist', 'not_found');
  return unique.map((m) => ({
    memberType: m.type,
    userId: m.type === 'USER' ? m.id : null,
    memberGroupId: m.type === 'GROUP' ? m.id : null,
    orgUnitId: m.type === 'ORG_UNIT' || m.type === 'ORG_UNIT_AND_SUBORDINATES' ? m.id : null,
  }));
}

function symmetricDifference(a: readonly string[], b: readonly string[]): string[] {
  const left = new Set(a);
  const right = new Set(b);
  return [...new Set([...a, ...b])].filter((x) => left.has(x) !== right.has(x));
}

function assertObjects(objects: readonly string[]): string[] {
  const bad = objects.filter((o) => !isStandardObject(o));
  if (bad.length) throw invalid('objects', `Unknown objects: ${bad.join(', ')}`, 'not_found');
  return [...new Set(objects)];
}

/**
 * Public groups and queues (§6.3). Membership is transitive (nested groups, org units, subtrees)
 * and feeds principals, owner rules and — for queues — owner visibility, so every change keeps
 * those current: principals by permVersion (database triggers), visibility synchronously, and
 * owner rules by background recalculation.
 */
@Injectable()
export class GroupsService {
  // ── Public groups ──────────────────────────────────────────────────────────────────────────
  async listGroups(tx: TenantTransaction): Promise<{ items: PublicGroup[] }> {
    const rows = await tx.prisma.publicGroup.findMany({
      where: { deletedAt: null },
      select: { id: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const items: PublicGroup[] = [];
    for (const r of rows) items.push(await this.getGroup(tx, r.id));
    return { items };
  }

  async getGroup(tx: TenantTransaction, id: string): Promise<PublicGroup> {
    const group = await tx.prisma.publicGroup.findFirst({
      where: { id, deletedAt: null },
      include: { members: { select: MEMBER_SELECT } },
    });
    if (!group) throw errors.notFound('Group');
    return {
      id: group.id,
      name: group.name,
      description: group.description,
      members: group.members.map(memberDto).sort(byTypeThenName),
      userCount: (await membership.groupUsers(tx, id)).length,
      version: group.version,
    };
  }

  private async assertGroupName(tx: TenantTransaction, name: string, except?: string) {
    if (
      await tx.prisma.publicGroup.findFirst({
        where: { name, ...(except ? { NOT: { id: except } } : {}) },
      })
    )
      throw nameTaken();
  }

  private async replaceGroupMembers(
    tx: TenantTransaction,
    groupId: string,
    members: MemberInput[],
  ) {
    const rows = await memberRows(tx, members);
    const { tenantId, userId } = tx.context;
    await tx.prisma.groupMember.deleteMany({ where: { groupId } });
    try {
      await tx.prisma.groupMember.createMany({
        data: rows.map((r) => ({ ...r, tenantId, groupId, createdBy: userId ?? null })),
      });
    } catch (err) {
      rethrowConflict(err);
    }
  }

  async createGroup(
    tx: TenantTransaction,
    input: z.infer<typeof CreateGroupRequest>,
  ): Promise<PublicGroup> {
    await this.assertGroupName(tx, input.name);
    const actor = tx.context.userId ?? null;
    const group = await tx.prisma.publicGroup.create({
      data: {
        tenantId: tx.context.tenantId,
        name: input.name,
        description: input.description ?? null,
        createdBy: actor,
        updatedBy: actor,
      },
    });
    await this.replaceGroupMembers(tx, group.id, input.members);
    const after = await this.getGroup(tx, group.id);
    await audit.setup(tx, {
      action: 'group.created',
      entityType: 'public_group',
      entityId: group.id,
      entityName: group.name,
      after: { name: after.name, members: after.members },
    });
    return after;
  }

  async updateGroup(
    tx: TenantTransaction,
    id: string,
    input: z.infer<typeof UpdateGroupRequest>,
  ): Promise<PublicGroup> {
    const current = await tx.prisma.publicGroup.findFirst({ where: { id, deletedAt: null } });
    assertVersion(current, input.version, 'Group');
    const before = await this.getGroup(tx, id);
    if (input.name) await this.assertGroupName(tx, input.name, id);
    const updated = await tx.prisma.publicGroup.updateMany({
      where: { id, version: input.version },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        version: { increment: 1 },
        updatedBy: tx.context.userId ?? null,
      },
    });
    if (updated.count !== 1) assertVersion(null, input.version, 'Group');
    if (input.members) {
      const usersBefore = await membership.groupUsers(tx, id);
      await this.replaceGroupMembers(tx, id, input.members);
      await recalculateOwnerRules(tx);
      // Queues containing this group (directly or through other groups) give its users sight of
      // queue-owned records: rebuild owner visibility for whoever joined or left.
      if (await tx.prisma.queueMember.count({ where: { memberType: 'GROUP' } })) {
        const usersAfter = await membership.groupUsers(tx, id);
        const changed = symmetricDifference(usersBefore, usersAfter);
        if (changed.length) await visibility.rebuild(tx, changed);
      }
    }
    const after = await this.getGroup(tx, id);
    await audit.setup(tx, {
      action: 'group.updated',
      entityType: 'public_group',
      entityId: id,
      entityName: before.name,
      before: { name: before.name, description: before.description, members: before.members },
      after: { name: after.name, description: after.description, members: after.members },
    });
    return after;
  }

  /** A group can go once nothing refers to it: other groups, queues or sharing rules. */
  async removeGroup(tx: TenantTransaction, id: string): Promise<void> {
    const group = await tx.prisma.publicGroup.findFirst({
      where: { id, deletedAt: null },
      include: { _count: { select: { memberOf: true, inQueues: true } } },
    });
    if (!group) throw errors.notFound('Group');
    if (group._count.memberOf || group._count.inQueues)
      throw errors.conflict('Remove this group from the groups and queues it belongs to first');
    const rules = await tx.prisma.sharingRule.count({
      where: { OR: [{ sourceId: id }, { targetId: id }] },
    });
    if (rules) throw errors.conflict('Sharing rules refer to this group; change them first');
    await tx.prisma.recordShare.deleteMany({ where: { principalType: 'GROUP', principalId: id } });
    await tx.prisma.publicGroup.delete({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
    });
    await audit.setup(tx, {
      action: 'group.deleted',
      entityType: 'public_group',
      entityId: id,
      entityName: group.name,
      before: { name: group.name },
    });
  }

  // ── Queues ─────────────────────────────────────────────────────────────────────────────────
  async listQueues(tx: TenantTransaction): Promise<{ items: Queue[] }> {
    const rows = await tx.prisma.queue.findMany({
      where: { deletedAt: null },
      select: { id: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const items: Queue[] = [];
    for (const r of rows) items.push(await this.getQueue(tx, r.id));
    return { items };
  }

  async getQueue(tx: TenantTransaction, id: string): Promise<Queue> {
    const queue = await tx.prisma.queue.findFirst({
      where: { id, deletedAt: null },
      include: { members: { select: MEMBER_SELECT }, objects: { select: { object: true } } },
    });
    if (!queue) throw errors.notFound('Queue');
    return {
      id: queue.id,
      name: queue.name,
      email: queue.email,
      description: queue.description,
      objects: queue.objects.map((o) => o.object).sort(),
      members: queue.members.map(memberDto).sort(byTypeThenName),
      userCount: (await membership.queueUsers(tx, id)).length,
      version: queue.version,
    };
  }

  private async assertQueueName(tx: TenantTransaction, name: string, except?: string) {
    if (
      await tx.prisma.queue.findFirst({
        where: { name, ...(except ? { NOT: { id: except } } : {}) },
      })
    )
      throw nameTaken();
  }

  private async replaceQueueMembers(
    tx: TenantTransaction,
    queueId: string,
    members: MemberInput[],
  ) {
    const rows = await memberRows(tx, members);
    const { tenantId, userId } = tx.context;
    await tx.prisma.queueMember.deleteMany({ where: { queueId } });
    await tx.prisma.queueMember.createMany({
      data: rows.map((r) => ({ ...r, tenantId, queueId, createdBy: userId ?? null })),
    });
  }

  private async replaceQueueObjects(tx: TenantTransaction, queueId: string, objects: string[]) {
    const { tenantId } = tx.context;
    await tx.prisma.queueObject.deleteMany({ where: { queueId } });
    await tx.prisma.queueObject.createMany({
      data: objects.map((object) => ({ tenantId, queueId, object })),
    });
  }

  async createQueue(
    tx: TenantTransaction,
    input: z.infer<typeof CreateQueueRequest>,
  ): Promise<Queue> {
    const objects = assertObjects(input.objects);
    await this.assertQueueName(tx, input.name);
    const actor = tx.context.userId ?? null;
    const queue = await tx.prisma.queue.create({
      data: {
        tenantId: tx.context.tenantId,
        name: input.name,
        email: input.email ?? null,
        description: input.description ?? null,
        createdBy: actor,
        updatedBy: actor,
      },
    });
    await this.replaceQueueObjects(tx, queue.id, objects);
    await this.replaceQueueMembers(tx, queue.id, input.members);
    const members = await membership.queueUsers(tx, queue.id);
    if (members.length) await visibility.rebuild(tx, members);
    const after = await this.getQueue(tx, queue.id);
    await audit.setup(tx, {
      action: 'queue.created',
      entityType: 'queue',
      entityId: queue.id,
      entityName: queue.name,
      after: { name: after.name, objects: after.objects, members: after.members },
    });
    return after;
  }

  async updateQueue(
    tx: TenantTransaction,
    id: string,
    input: z.infer<typeof UpdateQueueRequest>,
  ): Promise<Queue> {
    const current = await tx.prisma.queue.findFirst({ where: { id, deletedAt: null } });
    assertVersion(current, input.version, 'Queue');
    const objects = input.objects ? assertObjects(input.objects) : null;
    if (input.name) await this.assertQueueName(tx, input.name, id);
    const before = await this.getQueue(tx, id);
    const usersBefore = await membership.queueUsers(tx, id);
    const updated = await tx.prisma.queue.updateMany({
      where: { id, version: input.version },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        version: { increment: 1 },
        updatedBy: tx.context.userId ?? null,
      },
    });
    if (updated.count !== 1) assertVersion(null, input.version, 'Queue');
    if (objects) await this.replaceQueueObjects(tx, id, objects);
    if (input.members) {
      await this.replaceQueueMembers(tx, id, input.members);
      const affected = new Set([...usersBefore, ...(await membership.queueUsers(tx, id))]);
      if (affected.size) await visibility.rebuild(tx, [...affected]);
    }
    const after = await this.getQueue(tx, id);
    await audit.setup(tx, {
      action: 'queue.updated',
      entityType: 'queue',
      entityId: id,
      entityName: before.name,
      before: {
        name: before.name,
        email: before.email,
        objects: before.objects,
        members: before.members,
      },
      after: {
        name: after.name,
        email: after.email,
        objects: after.objects,
        members: after.members,
      },
    });
    return after;
  }

  async removeQueue(tx: TenantTransaction, id: string): Promise<void> {
    const queue = await tx.prisma.queue.findFirst({ where: { id, deletedAt: null } });
    if (!queue) throw errors.notFound('Queue');
    const users = await membership.queueUsers(tx, id);
    await tx.prisma.recordShare.deleteMany({ where: { principalType: 'QUEUE', principalId: id } });
    await tx.prisma.queue.delete({ where: { tenantId_id: { tenantId: tx.context.tenantId, id } } });
    if (users.length) await visibility.rebuild(tx, users);
    await audit.setup(tx, {
      action: 'queue.deleted',
      entityType: 'queue',
      entityId: id,
      entityName: queue.name,
      before: { name: queue.name },
    });
  }
}
