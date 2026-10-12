import { Injectable } from '@nestjs/common';
import type {
  CreateScoringModelRequest,
  ScoringModelDto,
  ScoringRuleDto,
  UpdateScoringModelRequest,
} from '@sm/contracts';
import { audit, outbox, type TenantTransaction } from '@sm/db';
import { fitRuleError, SCORE_RECALC_TOPIC } from '@sm/records';
import { errors } from '@sm/server-kit';
import type { z } from 'zod';

import { MetadataService } from '../metadata/metadata.service.js';
import { assertVersion, isUniqueViolation, nameTaken } from './common.js';

type Model = z.infer<typeof ScoringModelDto>;
type RuleInput = z.output<typeof ScoringRuleDto>;

const INCLUDE = { rules: { orderBy: [{ sortOrder: 'asc' as const }, { name: 'asc' as const }] } };

interface Row {
  id: string;
  name: string;
  active: boolean;
  isPrimary: boolean;
  fitWeight: number;
  engagementHalfLifeDays: number;
  gradeBands: unknown;
  version: number;
  rules: {
    id: string;
    kind: 'FIT' | 'ENGAGEMENT';
    name: string;
    formula: string | null;
    event: string | null;
    points: number;
    active: boolean;
  }[];
}

const dto = (r: Row): Model => ({
  id: r.id,
  object: 'lead',
  name: r.name,
  active: r.active,
  isPrimary: r.isPrimary,
  fitWeight: r.fitWeight,
  engagementHalfLifeDays: r.engagementHalfLifeDays,
  gradeBands: r.gradeBands as Model['gradeBands'],
  version: r.version,
  rules: r.rules.map((x) => ({
    id: x.id,
    kind: x.kind,
    name: x.name,
    formula: x.formula,
    event: x.event as 'form_submission' | 'inbound_email' | null,
    points: x.points,
    active: x.active,
  })),
});

const auditView = (m: Model) =>
  JSON.parse(JSON.stringify({ ...m, version: undefined })) as Record<string, never>;

/** Setup → Lead scoring (§7.4): models with fit and engagement rules; one primary per object. */
@Injectable()
export class ScoringSetupService {
  constructor(private readonly metadata: MetadataService) {}

  private async checkRules(tx: TenantTransaction, rules: readonly RuleInput[]) {
    const metadata = await this.metadata.forTenant(tx);
    for (const [i, r] of rules.entries()) {
      const at = `rules.${String(i)}`;
      if (r.kind === 'FIT') {
        if (!r.formula)
          throw errors.validation([
            { field: `${at}.formula`, code: 'required', message: 'A fit rule needs a formula' },
          ]);
        const problem = fitRuleError(metadata, 'lead', r.formula);
        if (problem)
          throw errors.validation([
            { field: `${at}.formula`, code: problem, message: 'The formula cannot score leads' },
          ]);
      } else if (!r.event)
        throw errors.validation([
          { field: `${at}.event`, code: 'required', message: 'An engagement rule needs an event' },
        ]);
    }
  }

  private async writeRules(tx: TenantTransaction, modelId: string, rules: readonly RuleInput[]) {
    await tx.prisma.scoringRule.deleteMany({ where: { modelId } });
    if (rules.length)
      await tx.prisma.scoringRule.createMany({
        data: rules.map((r, i) => ({
          tenantId: tx.context.tenantId,
          modelId,
          kind: r.kind,
          name: r.name,
          formula: r.kind === 'FIT' ? (r.formula ?? null) : null,
          event: r.kind === 'ENGAGEMENT' ? (r.event ?? null) : null,
          points: r.points,
          active: r.active,
          sortOrder: i,
        })),
      });
  }

  /** Scores are recalculated in the background whenever the primary model may have changed. */
  private async recalc(tx: TenantTransaction) {
    await outbox.emit(tx, { topic: SCORE_RECALC_TOPIC, payload: {} });
  }

  async list(tx: TenantTransaction): Promise<Model[]> {
    return (
      await tx.prisma.scoringModel.findMany({ include: INCLUDE, orderBy: { name: 'asc' } })
    ).map(dto);
  }

  async get(tx: TenantTransaction, id: string): Promise<Model> {
    const row = await tx.prisma.scoringModel.findFirst({ where: { id }, include: INCLUDE });
    if (!row) throw errors.notFound('Scoring model');
    return dto(row);
  }

  async create(
    tx: TenantTransaction,
    input: z.output<typeof CreateScoringModelRequest>,
  ): Promise<Model> {
    await this.checkRules(tx, input.rules);
    if (input.isPrimary)
      await tx.prisma.scoringModel.updateMany({
        where: { object: input.object, isPrimary: true },
        data: { isPrimary: false, version: { increment: 1 } },
      });
    try {
      const model = await tx.prisma.scoringModel.create({
        data: {
          tenantId: tx.context.tenantId,
          object: input.object,
          name: input.name,
          active: input.active,
          isPrimary: input.isPrimary,
          fitWeight: input.fitWeight,
          engagementHalfLifeDays: input.engagementHalfLifeDays,
          gradeBands: input.gradeBands,
          createdBy: tx.context.userId ?? null,
        },
      });
      await this.writeRules(tx, model.id, input.rules);
      const out = await this.get(tx, model.id);
      if (out.isPrimary) await this.recalc(tx);
      await audit.setup(tx, {
        action: 'scoring_model.created',
        entityType: 'scoring_model',
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
    input: z.output<typeof UpdateScoringModelRequest>,
  ): Promise<Model> {
    const current = await tx.prisma.scoringModel.findFirst({ where: { id }, include: INCLUDE });
    assertVersion(current, input.version, 'Scoring model');
    const before = dto(current);
    if (input.rules) await this.checkRules(tx, input.rules);
    if (input.isPrimary)
      await tx.prisma.scoringModel.updateMany({
        where: { object: current.object, isPrimary: true, id: { not: id } },
        data: { isPrimary: false, version: { increment: 1 } },
      });
    try {
      await tx.prisma.scoringModel.update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.active === undefined ? {} : { active: input.active }),
          ...(input.isPrimary === undefined ? {} : { isPrimary: input.isPrimary }),
          ...(input.fitWeight === undefined ? {} : { fitWeight: input.fitWeight }),
          ...(input.engagementHalfLifeDays === undefined
            ? {}
            : { engagementHalfLifeDays: input.engagementHalfLifeDays }),
          ...(input.gradeBands === undefined ? {} : { gradeBands: input.gradeBands }),
          version: { increment: 1 },
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
    if (input.rules) await this.writeRules(tx, id, input.rules);
    const out = await this.get(tx, id);
    if (out.isPrimary || before.isPrimary) await this.recalc(tx);
    await audit.setup(tx, {
      action: 'scoring_model.updated',
      entityType: 'scoring_model',
      entityId: id,
      entityName: out.name,
      before: auditView(before),
      after: auditView(out),
    });
    return out;
  }

  async remove(tx: TenantTransaction, id: string): Promise<void> {
    const current = await this.get(tx, id);
    await tx.prisma.scoringModel.delete({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
    });
    await audit.setup(tx, {
      action: 'scoring_model.deleted',
      entityType: 'scoring_model',
      entityId: id,
      entityName: current.name,
      before: auditView(current),
    });
  }
}
