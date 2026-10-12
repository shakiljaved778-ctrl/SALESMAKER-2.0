import { Injectable } from '@nestjs/common';
import type {
  CreateSlaPolicyRequest,
  SlaPolicyDto,
  SlaTimerDto,
  UpdateSlaPolicyRequest,
} from '@sm/contracts';
import { audit, type TenantTransaction } from '@sm/db';
import { entryCriteriaError } from '@sm/records';
import { errors } from '@sm/server-kit';
import type { z } from 'zod';

import { MetadataService } from '../metadata/metadata.service.js';
import { assertVersion, isUniqueViolation, nameTaken } from './common.js';

type Policy = z.infer<typeof SlaPolicyDto>;
type Timer = z.infer<typeof SlaTimerDto>;

interface Row {
  id: string;
  object: string;
  name: string;
  metric: Policy['metric'];
  targetMinutes: number;
  businessHoursId: string | null;
  ownerTimezone: boolean;
  criteria: unknown;
  warnAtPercent: number | null;
  managerAtPercent: number | null;
  reassignAtPercent: number | null;
  reassignRuleId: string | null;
  active: boolean;
  sortOrder: number;
  version: number;
}

const dto = (r: Row): Policy => ({
  id: r.id,
  object: 'lead',
  name: r.name,
  metric: r.metric,
  targetMinutes: r.targetMinutes,
  businessHoursId: r.businessHoursId,
  ownerTimezone: r.ownerTimezone,
  ...(r.criteria === null ? {} : { criteria: r.criteria }),
  warnAtPercent: r.warnAtPercent,
  managerAtPercent: r.managerAtPercent,
  reassignAtPercent: r.reassignAtPercent,
  reassignRuleId: r.reassignRuleId,
  active: r.active,
  sortOrder: r.sortOrder,
  version: r.version,
});

const auditView = (p: Policy) =>
  JSON.parse(JSON.stringify({ ...p, version: undefined })) as Record<string, never>;

const invalid = (field: string, code: string, message: string) =>
  errors.validation([{ field, code, message }]);

/** A timer as a chip: running and past its warning point is at risk. */
export function timerDto(
  t: {
    id: string;
    ownerId: string;
    startedAt: Date;
    warnAt: Date | null;
    dueAt: Date;
    metAt: Date | null;
    breachedAt: Date | null;
    status: Timer['status'];
    policy: { id: string; name: string; metric: Timer['policy']['metric'] };
  },
  now: Date,
): Timer {
  const state: Timer['state'] =
    t.status === 'MET'
      ? 'met'
      : t.status === 'CANCELLED'
        ? 'cancelled'
        : t.status === 'BREACHED' || t.dueAt <= now
          ? 'breached'
          : t.warnAt && t.warnAt <= now
            ? 'at_risk'
            : 'on_track';
  return {
    id: t.id,
    policy: { id: t.policy.id, name: t.policy.name, metric: t.policy.metric },
    ownerId: t.ownerId,
    startedAt: t.startedAt.toISOString(),
    warnAt: t.warnAt?.toISOString() ?? null,
    dueAt: t.dueAt.toISOString(),
    metAt: t.metAt?.toISOString() ?? null,
    breachedAt: t.breachedAt?.toISOString() ?? null,
    status: t.status,
    state,
  };
}

/** Setup → SLA policies (§7.3). */
@Injectable()
export class SlaSetupService {
  constructor(private readonly metadata: MetadataService) {}

  private async check(
    tx: TenantTransaction,
    p: {
      criteria?: unknown;
      businessHoursId?: string | null | undefined;
      reassignAtPercent?: number | null | undefined;
      reassignRuleId?: string | null | undefined;
    },
  ) {
    if (p.criteria !== undefined && p.criteria !== null) {
      const problem = entryCriteriaError(await this.metadata.forTenant(tx), 'lead', {
        criteria: p.criteria,
      });
      if (problem) throw invalid('criteria', problem, 'The criteria cannot run');
    }
    if (
      p.businessHoursId &&
      !(await tx.prisma.businessHours.findFirst({ where: { id: p.businessHoursId } }))
    )
      throw invalid('businessHoursId', 'invalid_reference', 'No such business hours');
    if (p.reassignAtPercent && !p.reassignRuleId)
      throw invalid('reassignRuleId', 'required', 'Choose the rule that reassigns');
    if (
      p.reassignRuleId &&
      !(await tx.prisma.assignmentRule.findFirst({
        where: { id: p.reassignRuleId, object: 'lead' },
      }))
    )
      throw invalid('reassignRuleId', 'invalid_reference', 'No such lead assignment rule');
  }

  async list(tx: TenantTransaction): Promise<Policy[]> {
    const rows = await tx.prisma.slaPolicy.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map(dto);
  }

  async get(tx: TenantTransaction, id: string): Promise<Policy> {
    const row = await tx.prisma.slaPolicy.findFirst({ where: { id } });
    if (!row) throw errors.notFound('SLA policy');
    return dto(row);
  }

  async create(
    tx: TenantTransaction,
    input: z.output<typeof CreateSlaPolicyRequest>,
  ): Promise<Policy> {
    await this.check(tx, input);
    try {
      const row = await tx.prisma.slaPolicy.create({
        data: {
          tenantId: tx.context.tenantId,
          object: input.object,
          name: input.name,
          metric: input.metric,
          targetMinutes: input.targetMinutes,
          businessHoursId: input.businessHoursId,
          ownerTimezone: input.ownerTimezone,
          criteria: (input.criteria ?? undefined) as never,
          warnAtPercent: input.warnAtPercent,
          managerAtPercent: input.managerAtPercent,
          reassignAtPercent: input.reassignAtPercent,
          reassignRuleId: input.reassignRuleId,
          active: input.active,
          sortOrder: input.sortOrder,
          createdBy: tx.context.userId ?? null,
        },
      });
      const out = dto(row);
      await audit.setup(tx, {
        action: 'sla_policy.created',
        entityType: 'sla_policy',
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
    input: z.output<typeof UpdateSlaPolicyRequest>,
  ): Promise<Policy> {
    const current = await tx.prisma.slaPolicy.findFirst({ where: { id } });
    assertVersion(current, input.version, 'SLA policy');
    const merged = {
      criteria: input.criteria === undefined ? current.criteria : input.criteria,
      businessHoursId:
        input.businessHoursId === undefined ? current.businessHoursId : input.businessHoursId,
      reassignAtPercent:
        input.reassignAtPercent === undefined ? current.reassignAtPercent : input.reassignAtPercent,
      reassignRuleId:
        input.reassignRuleId === undefined ? current.reassignRuleId : input.reassignRuleId,
    };
    await this.check(tx, merged);
    const changed = (key: keyof typeof input) => input[key] !== undefined;
    try {
      const row = await tx.prisma.slaPolicy.update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
        data: {
          ...(changed('name') ? { name: input.name } : {}),
          ...(changed('metric') ? { metric: input.metric } : {}),
          ...(changed('targetMinutes') ? { targetMinutes: input.targetMinutes } : {}),
          ...(changed('businessHoursId') ? { businessHoursId: input.businessHoursId } : {}),
          ...(changed('ownerTimezone') ? { ownerTimezone: input.ownerTimezone } : {}),
          ...(changed('criteria') && input.criteria !== null
            ? { criteria: input.criteria as never }
            : {}),
          ...(changed('warnAtPercent') ? { warnAtPercent: input.warnAtPercent } : {}),
          ...(changed('managerAtPercent') ? { managerAtPercent: input.managerAtPercent } : {}),
          ...(changed('reassignAtPercent') ? { reassignAtPercent: input.reassignAtPercent } : {}),
          ...(changed('reassignRuleId') ? { reassignRuleId: input.reassignRuleId } : {}),
          ...(changed('active') ? { active: input.active } : {}),
          ...(changed('sortOrder') ? { sortOrder: input.sortOrder } : {}),
          version: { increment: 1 },
        },
      });
      // Clearing the criteria (all records) is a SQL NULL, not a JSON null.
      if (input.criteria === null)
        await tx.prisma.$executeRaw`UPDATE sla_policy SET criteria = NULL
          WHERE tenant_id = ${tx.context.tenantId}::uuid AND id = ${id}::uuid`;
      const out = input.criteria === null ? { ...dto(row), criteria: undefined } : dto(row);
      await audit.setup(tx, {
        action: 'sla_policy.updated',
        entityType: 'sla_policy',
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
    await tx.prisma.slaPolicy.delete({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
    });
    await audit.setup(tx, {
      action: 'sla_policy.deleted',
      entityType: 'sla_policy',
      entityId: id,
      entityName: current.name,
      before: auditView(current),
    });
  }
}
