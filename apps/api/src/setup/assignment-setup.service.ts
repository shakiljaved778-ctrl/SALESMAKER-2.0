import { Injectable } from '@nestjs/common';
import type {
  AssignmentEntryDto,
  AssignmentRuleDto,
  CreateAssignmentRuleRequest,
  UpdateAssignmentRuleRequest,
} from '@sm/contracts';
import { audit, type TenantTransaction } from '@sm/db';
import { entryCriteriaError } from '@sm/records';
import { errors } from '@sm/server-kit';
import type { z } from 'zod';

import { MetadataService } from '../metadata/metadata.service.js';
import { assertVersion, isUniqueViolation, nameTaken } from './common.js';

type Rule = z.infer<typeof AssignmentRuleDto>;
type EntryInput = z.output<typeof AssignmentEntryDto>;

const INCLUDE = {
  entries: {
    orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
    include: { members: true as const },
  },
};

interface Row {
  id: string;
  object: string;
  name: string;
  active: boolean;
  isDefault: boolean;
  version: number;
  entries: {
    id: string;
    name: string | null;
    criteria: unknown;
    formula: string | null;
    method: EntryInput['method'];
    settings: unknown;
    targetUserId: string | null;
    targetQueueId: string | null;
    active: boolean;
    members: {
      memberType: 'USER' | 'QUEUE' | 'ORG_UNIT';
      userId: string | null;
      queueId: string | null;
      orgUnitId: string | null;
      weight: number;
    }[];
  }[];
}

const dto = (r: Row): Rule => ({
  id: r.id,
  object: r.object as Rule['object'],
  name: r.name,
  active: r.active,
  isDefault: r.isDefault,
  version: r.version,
  entries: r.entries.map((e) => ({
    id: e.id,
    name: e.name,
    ...(e.criteria === null ? {} : { criteria: e.criteria }),
    formula: e.formula,
    method: e.method,
    settings: e.settings ?? {},
    targetUserId: e.targetUserId,
    targetQueueId: e.targetQueueId,
    active: e.active,
    members: e.members.map((m) => ({
      type: m.memberType,
      id: m.userId ?? m.queueId ?? m.orgUnitId ?? '',
      weight: m.weight,
    })),
  })),
});

const auditView = (r: Rule) =>
  JSON.parse(JSON.stringify({ ...r, version: undefined })) as Record<string, never>;

const invalid = (field: string, code: string, message: string) =>
  errors.validation([{ field, code, message }]);

/** Setup → Assignment rules (§7.3): ordered entries with criteria, a method and a pool. */
@Injectable()
export class AssignmentSetupService {
  constructor(private readonly metadata: MetadataService) {}

  /** Entries must compile, name their targets and point at users, queues and units that exist. */
  private async checkEntries(
    tx: TenantTransaction,
    object: string,
    entries: readonly EntryInput[],
  ) {
    const metadata = await this.metadata.forTenant(tx);
    const users = new Set<string>();
    const queues = new Set<string>();
    const units = new Set<string>();
    for (const [i, e] of entries.entries()) {
      const at = `entries.${String(i)}`;
      const problem = entryCriteriaError(metadata, object, {
        criteria: e.criteria ?? null,
        formula: e.formula ?? null,
      });
      if (problem) throw invalid(`${at}.criteria`, problem, 'The criteria or formula cannot run');
      if (e.method === 'SPECIFIC_USER' && !e.targetUserId)
        throw invalid(`${at}.targetUserId`, 'required', 'Choose the user');
      if (e.method === 'QUEUE' && !e.targetQueueId)
        throw invalid(`${at}.targetQueueId`, 'required', 'Choose the queue');
      const pooled = ['ROUND_ROBIN', 'WEIGHTED', 'LOAD_BALANCED', 'SKILLS_BASED'].includes(
        e.method,
      );
      if (pooled && e.members.length === 0)
        throw invalid(`${at}.members`, 'required', 'Add the users who share the records');
      if (e.settings.skillField && !metadata.field(object, e.settings.skillField))
        throw invalid(`${at}.settings.skillField`, 'unknown_field', 'No such field');
      if (e.targetUserId) users.add(e.targetUserId);
      if (e.targetQueueId) queues.add(e.targetQueueId);
      if (e.settings.fallback)
        (e.settings.fallback.type === 'USER' ? users : queues).add(e.settings.fallback.id);
      for (const m of e.members)
        (m.type === 'USER' ? users : m.type === 'QUEUE' ? queues : units).add(m.id);
    }
    const [u, q, o] = await Promise.all([
      tx.prisma.user.count({ where: { id: { in: [...users] }, deletedAt: null } }),
      tx.prisma.queue.count({
        where: { id: { in: [...queues] }, deletedAt: null, objects: { some: { object } } },
      }),
      tx.prisma.orgUnit.count({ where: { id: { in: [...units] }, deletedAt: null } }),
    ]);
    if (u !== users.size || q !== queues.size || o !== units.size)
      throw invalid(
        'entries',
        'invalid_reference',
        'A user, queue (serving this object) or org unit does not exist',
      );
  }

  private async writeEntries(
    tx: TenantTransaction,
    ruleId: string,
    entries: readonly EntryInput[],
  ) {
    const tenantId = tx.context.tenantId;
    await tx.prisma.assignmentRuleEntry.deleteMany({ where: { ruleId } });
    for (const [i, e] of entries.entries()) {
      const entry = await tx.prisma.assignmentRuleEntry.create({
        data: {
          tenantId,
          ruleId,
          sortOrder: i,
          name: e.name ?? null,
          criteria: (e.criteria ?? undefined) as never,
          formula: e.formula ?? null,
          method: e.method,
          settings: e.settings,
          targetUserId: e.targetUserId ?? null,
          targetQueueId: e.targetQueueId ?? null,
          active: e.active,
        },
      });
      if (e.members.length)
        await tx.prisma.assignmentPoolMember.createMany({
          data: e.members.map((m) => ({
            tenantId,
            entryId: entry.id,
            memberType: m.type,
            userId: m.type === 'USER' ? m.id : null,
            queueId: m.type === 'QUEUE' ? m.id : null,
            orgUnitId: m.type === 'ORG_UNIT' ? m.id : null,
            weight: m.weight,
          })),
        });
    }
  }

  async list(tx: TenantTransaction): Promise<Rule[]> {
    const rows = await tx.prisma.assignmentRule.findMany({
      include: INCLUDE,
      orderBy: [{ object: 'asc' }, { name: 'asc' }],
    });
    return rows.map((r) => dto(r));
  }

  async get(tx: TenantTransaction, id: string): Promise<Rule> {
    const row = await tx.prisma.assignmentRule.findFirst({ where: { id }, include: INCLUDE });
    if (!row) throw errors.notFound('Assignment rule');
    return dto(row);
  }

  async create(
    tx: TenantTransaction,
    input: z.output<typeof CreateAssignmentRuleRequest>,
  ): Promise<Rule> {
    await this.checkEntries(tx, input.object, input.entries);
    if (input.isDefault)
      await tx.prisma.assignmentRule.updateMany({
        where: { object: input.object, isDefault: true },
        data: { isDefault: false, version: { increment: 1 } },
      });
    try {
      const rule = await tx.prisma.assignmentRule.create({
        data: {
          tenantId: tx.context.tenantId,
          object: input.object,
          name: input.name,
          active: input.active,
          isDefault: input.isDefault,
          createdBy: tx.context.userId ?? null,
          updatedBy: tx.context.userId ?? null,
        },
      });
      await this.writeEntries(tx, rule.id, input.entries);
      const out = await this.get(tx, rule.id);
      await audit.setup(tx, {
        action: 'assignment_rule.created',
        entityType: 'assignment_rule',
        entityId: out.id,
        entityName: out.name,
        after: auditView(out),
      });
      return out;
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
  }

  async update(
    tx: TenantTransaction,
    id: string,
    input: z.output<typeof UpdateAssignmentRuleRequest>,
  ): Promise<Rule> {
    const current = await tx.prisma.assignmentRule.findFirst({ where: { id }, include: INCLUDE });
    assertVersion(current, input.version, 'Assignment rule');
    const before = dto(current);
    if (input.entries) await this.checkEntries(tx, current.object, input.entries);
    if (input.isDefault)
      await tx.prisma.assignmentRule.updateMany({
        where: { object: current.object, isDefault: true, id: { not: id } },
        data: { isDefault: false, version: { increment: 1 } },
      });
    try {
      await tx.prisma.assignmentRule.update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.active === undefined ? {} : { active: input.active }),
          ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
          updatedBy: tx.context.userId ?? null,
          version: { increment: 1 },
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
    if (input.entries) await this.writeEntries(tx, id, input.entries);
    const out = await this.get(tx, id);
    await audit.setup(tx, {
      action: 'assignment_rule.updated',
      entityType: 'assignment_rule',
      entityId: id,
      entityName: out.name,
      before: auditView(before),
      after: auditView(out),
    });
    return out;
  }

  async remove(tx: TenantTransaction, id: string): Promise<void> {
    const current = await this.get(tx, id);
    await tx.prisma.assignmentRule.delete({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
    });
    await audit.setup(tx, {
      action: 'assignment_rule.deleted',
      entityType: 'assignment_rule',
      entityId: id,
      entityName: current.name,
      before: auditView(current),
    });
  }
}
