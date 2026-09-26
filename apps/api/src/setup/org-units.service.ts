import { Injectable } from '@nestjs/common';
import type { CreateOrgUnitRequest, OrgUnitDto, UpdateOrgUnitRequest } from '@sm/contracts';
import { audit, visibility, type TenantTransaction } from '@sm/db';
import { errors } from '@sm/server-kit';
import type { z } from 'zod';

import { assertVersion, invalid, recalculateOwnerRules, rethrowConflict } from './common.js';

type OrgUnit = z.infer<typeof OrgUnitDto>;

const SELECT = {
  id: true,
  name: true,
  description: true,
  parentId: true,
  version: true,
  _count: { select: { users: true } },
} as const;

function dto(u: {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  version: number;
  _count: { users: number };
}): OrgUnit {
  return {
    id: u.id,
    name: u.name,
    description: u.description,
    parentId: u.parentId,
    users: u._count.users,
    version: u.version,
  };
}

/**
 * The org hierarchy (§6.3): an unlimited-depth tree whose closure the database maintains. A move
 * changes who sits above the moved subtree, so their owner visibility is rebuilt in the same
 * transaction and owner-based rules are recalculated.
 */
@Injectable()
export class OrgUnitsService {
  async list(tx: TenantTransaction): Promise<{ items: OrgUnit[] }> {
    const rows = await tx.prisma.orgUnit.findMany({
      where: { deletedAt: null },
      select: SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map(dto) };
  }

  async get(tx: TenantTransaction, id: string): Promise<OrgUnit> {
    const row = await tx.prisma.orgUnit.findFirst({
      where: { id, deletedAt: null },
      select: SELECT,
    });
    if (!row) throw errors.notFound('Org unit');
    return dto(row);
  }

  private async assertParent(tx: TenantTransaction, parentId: string | null | undefined) {
    if (
      parentId &&
      !(await tx.prisma.orgUnit.findFirst({ where: { id: parentId, deletedAt: null } }))
    )
      throw invalid('parentId', 'No such org unit', 'not_found');
  }

  async create(
    tx: TenantTransaction,
    input: z.infer<typeof CreateOrgUnitRequest>,
  ): Promise<OrgUnit> {
    await this.assertParent(tx, input.parentId);
    const actor = tx.context.userId ?? null;
    const row = await tx.prisma.orgUnit.create({
      data: {
        tenantId: tx.context.tenantId,
        name: input.name,
        description: input.description ?? null,
        parentId: input.parentId ?? null,
        createdBy: actor,
        updatedBy: actor,
      },
      select: SELECT,
    });
    await audit.setup(tx, {
      action: 'org_unit.created',
      entityType: 'org_unit',
      entityId: row.id,
      entityName: row.name,
      after: { name: row.name, parentId: row.parentId },
    });
    return dto(row);
  }

  async update(
    tx: TenantTransaction,
    id: string,
    input: z.infer<typeof UpdateOrgUnitRequest>,
  ): Promise<OrgUnit> {
    const before = await tx.prisma.orgUnit.findFirst({ where: { id, deletedAt: null } });
    assertVersion(before, input.version, 'Org unit');
    const moving = input.parentId !== undefined && input.parentId !== before.parentId;
    if (moving) await this.assertParent(tx, input.parentId);
    // Users above the subtree before the move lose sight of it; users above it after gain it.
    const above = moving ? await visibility.viewersAbove(tx, [id]) : [];
    const { version, ...changes } = input;
    try {
      const updated = await tx.prisma.orgUnit.updateMany({
        where: { id, version },
        data: { ...changes, version: { increment: 1 }, updatedBy: tx.context.userId ?? null },
      });
      if (updated.count !== 1) assertVersion(null, version, 'Org unit');
    } catch (err) {
      rethrowConflict(err);
    }
    if (moving) {
      const viewers = new Set([...above, ...(await visibility.viewersAbove(tx, [id]))]);
      // Queues naming a subtree (directly or through a group) may now contain these users.
      if (
        await tx.prisma.queueMember.count({
          where: { memberType: { in: ['GROUP', 'ORG_UNIT_AND_SUBORDINATES'] } },
        })
      )
        for (const u of await tx.prisma.user.findMany({
          where: { orgUnit: { ancestors: { some: { ancestorId: id } } } },
          select: { id: true },
        }))
          viewers.add(u.id);
      if (viewers.size) await visibility.rebuild(tx, [...viewers]);
      await recalculateOwnerRules(tx);
    }
    await audit.setup(tx, {
      action: moving ? 'org_unit.moved' : 'org_unit.updated',
      entityType: 'org_unit',
      entityId: id,
      entityName: before.name,
      before: Object.fromEntries(
        Object.keys(changes).map((k) => [k, (before as Record<string, unknown>)[k] ?? null]),
      ),
      after: changes,
    });
    return this.get(tx, id);
  }

  /** Only an empty, unreferenced unit can go: no child units, users, members or rules. */
  async remove(tx: TenantTransaction, id: string): Promise<void> {
    const unit = await tx.prisma.orgUnit.findFirst({
      where: { id, deletedAt: null },
      include: {
        _count: { select: { children: true, users: true, groupMembers: true, queueMembers: true } },
      },
    });
    if (!unit) throw errors.notFound('Org unit');
    const c = unit._count;
    if (c.children) throw errors.conflict('Move or delete the units below this one first');
    if (c.users) throw errors.conflict('Move the users of this unit elsewhere first');
    if (c.groupMembers || c.queueMembers)
      throw errors.conflict('Remove this unit from the groups and queues it belongs to first');
    const rules = await tx.prisma.sharingRule.count({
      where: { OR: [{ sourceId: id }, { targetId: id }] },
    });
    if (rules) throw errors.conflict('Sharing rules refer to this unit; change them first');
    await tx.prisma.recordShare.deleteMany({
      where: { principalType: { in: ['ORG_UNIT', 'ORG_UNIT_AND_SUBORDINATES'] }, principalId: id },
    });
    await tx.prisma.orgUnit.delete({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
    });
    await audit.setup(tx, {
      action: 'org_unit.deleted',
      entityType: 'org_unit',
      entityId: id,
      entityName: unit.name,
      before: { name: unit.name, parentId: unit.parentId },
    });
  }
}
