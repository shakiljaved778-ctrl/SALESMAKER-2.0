import { Injectable } from '@nestjs/common';
import type {
  CreateDuplicateRuleRequest,
  CreateMatchingRuleRequest,
  DuplicateRuleDto,
  MatchingRuleDto,
  UpdateDuplicateRuleRequest,
  UpdateMatchingRuleRequest,
} from '@sm/contracts';
import { audit, type TenantTransaction } from '@sm/db';
import { conditionErrors, type MatchCondition } from '@sm/records';
import { errors } from '@sm/server-kit';
import type { z } from 'zod';

import { MetadataService } from '../metadata/metadata.service.js';
import { assertVersion, isUniqueViolation, nameTaken } from './common.js';

type MatchingRule = z.infer<typeof MatchingRuleDto>;
type DuplicateRule = z.infer<typeof DuplicateRuleDto>;

interface MatchingRow {
  id: string;
  object: string;
  name: string;
  active: boolean;
  matchBlank: boolean;
  conditions: unknown;
  version: number;
  _count: { duplicateRules: number };
}

const matchingDto = (r: MatchingRow): MatchingRule => ({
  id: r.id,
  object: r.object as MatchingRule['object'],
  name: r.name,
  active: r.active,
  matchBlank: r.matchBlank,
  conditions: r.conditions as MatchingRule['conditions'],
  usedBy: r._count.duplicateRules,
  version: r.version,
});

const MATCHING_INCLUDE = { _count: { select: { duplicateRules: true } } } as const;
const DUPLICATE_INCLUDE = { matchingRule: { select: { id: true, name: true } } } as const;

interface DuplicateRow {
  id: string;
  object: string;
  name: string;
  action: 'BLOCK' | 'ALERT';
  onCreate: boolean;
  onEdit: boolean;
  bypassProfileIds: string[];
  active: boolean;
  sortOrder: number;
  version: number;
  matchingRule: { id: string; name: string };
}

const duplicateDto = (r: DuplicateRow): DuplicateRule => ({
  id: r.id,
  object: r.object as DuplicateRule['object'],
  name: r.name,
  matchingRule: r.matchingRule,
  action: r.action,
  onCreate: r.onCreate,
  onEdit: r.onEdit,
  bypassProfileIds: r.bypassProfileIds,
  active: r.active,
  sortOrder: r.sortOrder,
  version: r.version,
});

/** The rule as audited (its version is not part of what changed). */
const auditView = (r: MatchingRule | DuplicateRule) =>
  JSON.parse(JSON.stringify({ ...r, version: undefined })) as Record<string, never>;

/** Setup → Duplicate management (§7.2): matching rules and the duplicate rules that use them. */
@Injectable()
export class DedupeSetupService {
  constructor(private readonly metadata: MetadataService) {}

  private async checkConditions(
    tx: TenantTransaction,
    object: string,
    conditions: readonly MatchCondition[],
  ) {
    const meta = (await this.metadata.forTenant(tx)).object(object);
    if (!meta) throw errors.notFound('Object');
    const problems = conditionErrors(meta, conditions);
    if (problems.length)
      throw errors.validation(
        problems.map((p) => ({
          field: p.field,
          code: p.code,
          message: p.code.replaceAll('_', ' '),
        })),
      );
  }

  async listMatching(tx: TenantTransaction): Promise<MatchingRule[]> {
    const rows = await tx.prisma.matchingRule.findMany({
      include: MATCHING_INCLUDE,
      orderBy: [{ object: 'asc' }, { name: 'asc' }],
    });
    return rows.map(matchingDto);
  }

  async getMatching(tx: TenantTransaction, id: string): Promise<MatchingRule> {
    const row = await tx.prisma.matchingRule.findFirst({
      where: { id },
      include: MATCHING_INCLUDE,
    });
    if (!row) throw errors.notFound('Matching rule');
    return matchingDto(row);
  }

  async createMatching(
    tx: TenantTransaction,
    input: z.output<typeof CreateMatchingRuleRequest>,
  ): Promise<MatchingRule> {
    await this.checkConditions(tx, input.object, input.conditions);
    try {
      const row = await tx.prisma.matchingRule.create({
        data: {
          tenantId: tx.context.tenantId,
          object: input.object,
          name: input.name,
          active: input.active,
          matchBlank: input.matchBlank,
          conditions: input.conditions,
          createdBy: tx.context.userId ?? null,
          updatedBy: tx.context.userId ?? null,
        },
        include: MATCHING_INCLUDE,
      });
      const dto = matchingDto(row);
      await audit.setup(tx, {
        action: 'matching_rule.created',
        entityType: 'matching_rule',
        entityId: dto.id,
        entityName: dto.name,
        after: auditView(dto),
      });
      return dto;
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
  }

  async updateMatching(
    tx: TenantTransaction,
    id: string,
    input: z.output<typeof UpdateMatchingRuleRequest>,
  ): Promise<MatchingRule> {
    const current = await tx.prisma.matchingRule.findFirst({
      where: { id },
      include: MATCHING_INCLUDE,
    });
    assertVersion(current, input.version, 'Matching rule');
    if (input.conditions) await this.checkConditions(tx, current.object, input.conditions);
    try {
      const row = await tx.prisma.matchingRule.update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.active === undefined ? {} : { active: input.active }),
          ...(input.matchBlank === undefined ? {} : { matchBlank: input.matchBlank }),
          ...(input.conditions === undefined ? {} : { conditions: input.conditions }),
          updatedBy: tx.context.userId ?? null,
          version: { increment: 1 },
        },
        include: MATCHING_INCLUDE,
      });
      const dto = matchingDto(row);
      await audit.setup(tx, {
        action: 'matching_rule.updated',
        entityType: 'matching_rule',
        entityId: id,
        entityName: dto.name,
        before: auditView(matchingDto(current)),
        after: auditView(dto),
      });
      return dto;
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
  }

  async deleteMatching(tx: TenantTransaction, id: string): Promise<void> {
    const current = await tx.prisma.matchingRule.findFirst({
      where: { id },
      include: MATCHING_INCLUDE,
    });
    if (!current) throw errors.notFound('Matching rule');
    if (current._count.duplicateRules > 0)
      throw errors.conflict('Duplicate rules use this matching rule; change or delete them first');
    await tx.prisma.matchingRule.delete({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
    });
    await audit.setup(tx, {
      action: 'matching_rule.deleted',
      entityType: 'matching_rule',
      entityId: id,
      entityName: current.name,
      before: auditView(matchingDto(current)),
    });
  }

  private async checkDuplicateRefs(
    tx: TenantTransaction,
    object: string,
    input: { matchingRuleId?: string | undefined; bypassProfileIds?: string[] | undefined },
  ) {
    if (input.matchingRuleId) {
      const matching = await tx.prisma.matchingRule.findFirst({
        where: { id: input.matchingRuleId },
      });
      if (!matching || matching.object !== object)
        throw errors.validation([
          {
            field: 'matchingRuleId',
            code: 'invalid_reference',
            message: 'Choose a matching rule for the same object',
          },
        ]);
    }
    const profiles = [...new Set(input.bypassProfileIds ?? [])];
    if (profiles.length) {
      const found = await tx.prisma.profile.count({ where: { id: { in: profiles } } });
      if (found !== profiles.length)
        throw errors.validation([
          { field: 'bypassProfileIds', code: 'invalid_reference', message: 'No such profile' },
        ]);
    }
  }

  async listDuplicate(tx: TenantTransaction): Promise<DuplicateRule[]> {
    const rows = await tx.prisma.duplicateRule.findMany({
      include: DUPLICATE_INCLUDE,
      orderBy: [{ object: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map(duplicateDto);
  }

  async getDuplicate(tx: TenantTransaction, id: string): Promise<DuplicateRule> {
    const row = await tx.prisma.duplicateRule.findFirst({
      where: { id },
      include: DUPLICATE_INCLUDE,
    });
    if (!row) throw errors.notFound('Duplicate rule');
    return duplicateDto(row);
  }

  async createDuplicate(
    tx: TenantTransaction,
    input: z.output<typeof CreateDuplicateRuleRequest>,
  ): Promise<DuplicateRule> {
    if (!input.onCreate && !input.onEdit)
      throw errors.validation([
        { field: 'onCreate', code: 'required', message: 'Run the rule on create, edit or both' },
      ]);
    await this.checkDuplicateRefs(tx, input.object, input);
    try {
      const row = await tx.prisma.duplicateRule.create({
        data: {
          tenantId: tx.context.tenantId,
          object: input.object,
          name: input.name,
          matchingRuleId: input.matchingRuleId,
          action: input.action,
          onCreate: input.onCreate,
          onEdit: input.onEdit,
          bypassProfileIds: [...new Set(input.bypassProfileIds)],
          active: input.active,
          sortOrder: input.sortOrder,
          createdBy: tx.context.userId ?? null,
          updatedBy: tx.context.userId ?? null,
        },
        include: DUPLICATE_INCLUDE,
      });
      const dto = duplicateDto(row);
      await audit.setup(tx, {
        action: 'duplicate_rule.created',
        entityType: 'duplicate_rule',
        entityId: dto.id,
        entityName: dto.name,
        after: auditView(dto),
      });
      return dto;
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
  }

  async updateDuplicate(
    tx: TenantTransaction,
    id: string,
    input: z.output<typeof UpdateDuplicateRuleRequest>,
  ): Promise<DuplicateRule> {
    const current = await tx.prisma.duplicateRule.findFirst({
      where: { id },
      include: DUPLICATE_INCLUDE,
    });
    assertVersion(current, input.version, 'Duplicate rule');
    if (!(input.onCreate ?? current.onCreate) && !(input.onEdit ?? current.onEdit))
      throw errors.validation([
        { field: 'onCreate', code: 'required', message: 'Run the rule on create, edit or both' },
      ]);
    await this.checkDuplicateRefs(tx, current.object, input);
    try {
      const row = await tx.prisma.duplicateRule.update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.matchingRuleId === undefined ? {} : { matchingRuleId: input.matchingRuleId }),
          ...(input.action === undefined ? {} : { action: input.action }),
          ...(input.onCreate === undefined ? {} : { onCreate: input.onCreate }),
          ...(input.onEdit === undefined ? {} : { onEdit: input.onEdit }),
          ...(input.bypassProfileIds === undefined
            ? {}
            : { bypassProfileIds: [...new Set(input.bypassProfileIds)] }),
          ...(input.active === undefined ? {} : { active: input.active }),
          ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
          updatedBy: tx.context.userId ?? null,
          version: { increment: 1 },
        },
        include: DUPLICATE_INCLUDE,
      });
      const dto = duplicateDto(row);
      await audit.setup(tx, {
        action: 'duplicate_rule.updated',
        entityType: 'duplicate_rule',
        entityId: id,
        entityName: dto.name,
        before: auditView(duplicateDto(current)),
        after: auditView(dto),
      });
      return dto;
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
  }

  async deleteDuplicate(tx: TenantTransaction, id: string): Promise<void> {
    const current = await tx.prisma.duplicateRule.findFirst({
      where: { id },
      include: DUPLICATE_INCLUDE,
    });
    if (!current) throw errors.notFound('Duplicate rule');
    await tx.prisma.duplicateRule.delete({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
    });
    await audit.setup(tx, {
      action: 'duplicate_rule.deleted',
      entityType: 'duplicate_rule',
      entityId: id,
      entityName: current.name,
      before: auditView(duplicateDto(current)),
    });
  }
}
