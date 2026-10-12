import { Injectable } from '@nestjs/common';
import type {
  CreateRecycleRuleRequest,
  RecycleRuleDto,
  UpdateRecycleRuleRequest,
} from '@sm/contracts';
import { audit, type TenantTransaction } from '@sm/db';
import { entryCriteriaError } from '@sm/records';
import { errors } from '@sm/server-kit';
import type { z } from 'zod';

import { MetadataService } from '../metadata/metadata.service.js';
import { assertVersion, isUniqueViolation, nameTaken } from './common.js';

type Rule = z.infer<typeof RecycleRuleDto>;
interface Row {
  id: string;
  name: string;
  active: boolean;
  fromCategories: string[];
  afterDays: number;
  criteria: unknown;
  targetStatus: string;
  assignmentRuleId: string | null;
  sortOrder: number;
  version: number;
}

const dto = (r: Row): Rule => ({
  id: r.id,
  object: 'lead',
  name: r.name,
  active: r.active,
  fromCategories: r.fromCategories as Rule['fromCategories'],
  afterDays: r.afterDays,
  ...(r.criteria === null ? {} : { criteria: r.criteria }),
  targetStatus: r.targetStatus,
  assignmentRuleId: r.assignmentRuleId,
  sortOrder: r.sortOrder,
  version: r.version,
});

const auditView = (r: Rule) =>
  JSON.parse(JSON.stringify({ ...r, version: undefined })) as Record<string, never>;
const invalid = (field: string, code: string, message: string) =>
  errors.validation([{ field, code, message }]);

/** Setup → Lead recycling (§7.3). */
@Injectable()
export class RecycleSetupService {
  constructor(private readonly metadata: MetadataService) {}

  private async check(
    tx: TenantTransaction,
    r: {
      criteria?: unknown;
      targetStatus?: string | undefined;
      assignmentRuleId?: string | null | undefined;
    },
  ) {
    const metadata = await this.metadata.forTenant(tx);
    if (r.criteria !== undefined && r.criteria !== null) {
      const problem = entryCriteriaError(metadata, 'lead', { criteria: r.criteria });
      if (problem) throw invalid('criteria', problem, 'The criteria cannot run');
    }
    if (r.targetStatus !== undefined) {
      const value = metadata
        .field('lead', 'status')
        ?.picklistValues.find((v) => v.apiValue === r.targetStatus);
      if (!value || value.category !== 'OPEN')
        throw invalid('targetStatus', 'not_open', 'Choose an open lead status');
    }
    if (
      r.assignmentRuleId &&
      !(await tx.prisma.assignmentRule.findFirst({
        where: { id: r.assignmentRuleId, object: 'lead' },
      }))
    )
      throw invalid('assignmentRuleId', 'invalid_reference', 'No such lead assignment rule');
  }

  async list(tx: TenantTransaction): Promise<Rule[]> {
    return (
      await tx.prisma.recycleRule.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })
    ).map(dto);
  }

  async get(tx: TenantTransaction, id: string): Promise<Rule> {
    const row = await tx.prisma.recycleRule.findFirst({ where: { id } });
    if (!row) throw errors.notFound('Recycle rule');
    return dto(row);
  }

  async create(
    tx: TenantTransaction,
    input: z.output<typeof CreateRecycleRuleRequest>,
  ): Promise<Rule> {
    await this.check(tx, input);
    try {
      const row = await tx.prisma.recycleRule.create({
        data: {
          tenantId: tx.context.tenantId,
          object: input.object,
          name: input.name,
          active: input.active,
          fromCategories: [...new Set(input.fromCategories)],
          afterDays: input.afterDays,
          ...(input.criteria === undefined || input.criteria === null
            ? {}
            : { criteria: input.criteria as never }),
          targetStatus: input.targetStatus,
          assignmentRuleId: input.assignmentRuleId,
          sortOrder: input.sortOrder,
          createdBy: tx.context.userId ?? null,
        },
      });
      const out = dto(row);
      await audit.setup(tx, {
        action: 'recycle_rule.created',
        entityType: 'recycle_rule',
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
    input: z.output<typeof UpdateRecycleRuleRequest>,
  ): Promise<Rule> {
    const current = await tx.prisma.recycleRule.findFirst({ where: { id } });
    assertVersion(current, input.version, 'Recycle rule');
    await this.check(tx, input);
    const has = (k: keyof typeof input) => input[k] !== undefined;
    try {
      const row = await tx.prisma.recycleRule.update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
        data: {
          ...(has('name') ? { name: input.name } : {}),
          ...(has('active') ? { active: input.active } : {}),
          ...(input.fromCategories ? { fromCategories: [...new Set(input.fromCategories)] } : {}),
          ...(has('afterDays') ? { afterDays: input.afterDays } : {}),
          ...(has('criteria') && input.criteria !== null
            ? { criteria: input.criteria as never }
            : {}),
          ...(has('targetStatus') ? { targetStatus: input.targetStatus } : {}),
          ...(has('assignmentRuleId') ? { assignmentRuleId: input.assignmentRuleId } : {}),
          ...(has('sortOrder') ? { sortOrder: input.sortOrder } : {}),
          version: { increment: 1 },
        },
      });
      if (input.criteria === null)
        await tx.prisma.$executeRaw`UPDATE recycle_rule SET criteria = NULL
          WHERE tenant_id = ${tx.context.tenantId}::uuid AND id = ${id}::uuid`;
      const out = input.criteria === null ? { ...dto(row), criteria: undefined } : dto(row);
      await audit.setup(tx, {
        action: 'recycle_rule.updated',
        entityType: 'recycle_rule',
        entityId: id,
        entityName: out.name,
        before: auditView(dto(current)),
        after: auditView(out),
      });
      return out;
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
  }

  async remove(tx: TenantTransaction, id: string): Promise<void> {
    const current = await this.get(tx, id);
    await tx.prisma.recycleRule.delete({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
    });
    await audit.setup(tx, {
      action: 'recycle_rule.deleted',
      entityType: 'recycle_rule',
      entityId: id,
      entityName: current.name,
      before: auditView(current),
    });
  }
}
