import { Injectable } from '@nestjs/common';
import type {
  CreateSharingRuleRequest,
  ManualShareRequest,
  OrgWideDefaultDto,
  RecordShareDto,
  SharingRuleDto,
  UpdateOrgWideDefaultRequest,
  UpdateSharingRuleRequest,
} from '@sm/contracts';
import { audit, outbox, type TenantTransaction } from '@sm/db';
import { STANDARD_OBJECTS, standardField, standardObject } from '@sm/metadata';
import {
  filterFields,
  grantManualShare,
  NIL_UUID,
  parseFilter,
  revokeManualShare,
  type SharePrincipalType,
} from '@sm/query-engine';
import { errors } from '@sm/server-kit';
import type { z } from 'zod';

import { AccessService } from '../access/access.service.js';
import { SharingService } from '../sharing/sharing.service.js';
import { assertVersion, invalid, nameTaken, RULE_CHANGED, RULE_DELETED } from './common.js';

type OrgWideDefault = z.infer<typeof OrgWideDefaultDto>;
type SharingRule = z.infer<typeof SharingRuleDto>;
type RecordShare = z.infer<typeof RecordShareDto>;
type Principal = { type: SharePrincipalType; id: string };

const ACCESS_NUMBER = { read: 1, edit: 2 } as const;
const ACCESS_NAME = { 1: 'read', 2: 'edit', 3: 'full' } as const;
const ruleAccess = (n: number): 'read' | 'edit' => (n === 2 ? 'edit' : 'read');

/** Sharing rules and manual shares add access; under these models there is nothing to add. */
const NO_SHARING = new Set(['PUBLIC_READ_WRITE', 'CONTROLLED_BY_PARENT']);

/** Display names of principals, looked up per type in one query each. */
async function principalNames(
  tx: TenantTransaction,
  refs: readonly Principal[],
): Promise<Map<string, string>> {
  const ids = (types: SharePrincipalType[]) => [
    ...new Set(refs.filter((r) => types.includes(r.type)).map((r) => r.id)),
  ];
  const [users, groups, queues, units] = await Promise.all([
    tx.prisma.user.findMany({
      where: { id: { in: ids(['USER']) } },
      select: { id: true, name: true },
    }),
    tx.prisma.publicGroup.findMany({
      where: { id: { in: ids(['GROUP']) } },
      select: { id: true, name: true },
    }),
    tx.prisma.queue.findMany({
      where: { id: { in: ids(['QUEUE']) } },
      select: { id: true, name: true },
    }),
    tx.prisma.orgUnit.findMany({
      where: { id: { in: ids(['ORG_UNIT', 'ORG_UNIT_AND_SUBORDINATES']) } },
      select: { id: true, name: true },
    }),
  ]);
  return new Map([...users, ...groups, ...queues, ...units].map((r) => [r.id, r.name]));
}

/** Throw a validation error unless the principal exists in this workspace. */
async function assertPrincipal(tx: TenantTransaction, field: string, p: Principal): Promise<void> {
  const where = { id: p.id, deletedAt: null };
  const found =
    p.type === 'USER'
      ? await tx.prisma.user.count({ where })
      : p.type === 'GROUP'
        ? await tx.prisma.publicGroup.count({ where })
        : p.type === 'QUEUE'
          ? await tx.prisma.queue.count({ where })
          : await tx.prisma.orgUnit.count({ where });
  if (!found) throw invalid(field, 'No such user, group or org unit', 'not_found');
}

/** A criteria filter must parse and read only the object's own fields. */
function assertCriteria(object: string, criteria: unknown): void {
  let fields: string[];
  try {
    fields = filterFields(parseFilter(criteria));
  } catch (err) {
    throw invalid('criteria', err instanceof Error ? err.message.slice(0, 200) : 'Invalid filter');
  }
  const unknown = fields.filter((f) => !standardField(object, f));
  if (unknown.length)
    throw invalid('criteria', `Unknown fields: ${unknown.join(', ')}`, 'not_found');
}

/**
 * Org-wide defaults, sharing rules and manual shares (§6.3, §6.4). OWD changes take effect on the
 * next query (the predicate reads them live; permVersion bumps). Rule changes are recalculated by
 * the worker and tracked in job_run; manual shares need Full access to the record.
 */
@Injectable()
export class SharingSetupService {
  constructor(
    private readonly sharing: SharingService,
    private readonly access: AccessService,
  ) {}

  // ── Org-wide defaults ──────────────────────────────────────────────────────────────────────
  private async owd(tx: TenantTransaction, object: string): Promise<OrgWideDefault> {
    const meta = standardObject(object);
    if (!meta) throw errors.notFound('Object');
    const current = await this.sharing.orgWideDefault(tx, object);
    return {
      object,
      sharingModel: current.sharingModel,
      grantHierarchy: current.grantHierarchy,
      allowedModels: [...meta.sharing.allowed],
      hierarchyEditable: false,
    };
  }

  async listOwd(tx: TenantTransaction): Promise<{ items: OrgWideDefault[] }> {
    const items: OrgWideDefault[] = [];
    for (const o of STANDARD_OBJECTS) items.push(await this.owd(tx, o.apiName));
    return { items };
  }

  async updateOwd(
    tx: TenantTransaction,
    object: string,
    input: z.infer<typeof UpdateOrgWideDefaultRequest>,
  ): Promise<OrgWideDefault> {
    const before = await this.owd(tx, object);
    if (!before.allowedModels.includes(input.sharingModel))
      throw invalid('sharingModel', `${object} cannot use ${input.sharingModel}`);
    if (input.grantHierarchy === false)
      throw invalid('grantHierarchy', 'Standard objects always grant access through the hierarchy');
    const { tenantId } = tx.context;
    const updatedBy = tx.context.userId ?? null;
    await tx.prisma.orgWideDefault.upsert({
      where: { tenantId_object: { tenantId, object } },
      create: {
        tenantId,
        object,
        sharingModel: input.sharingModel,
        grantHierarchy: true,
        updatedBy,
      },
      update: { sharingModel: input.sharingModel, version: { increment: 1 }, updatedBy },
    });
    if (before.sharingModel !== input.sharingModel)
      await audit.setup(tx, {
        action: 'sharing.owd_changed',
        entityType: 'org_wide_default',
        entityName: object,
        before: { sharingModel: before.sharingModel },
        after: { sharingModel: input.sharingModel },
      });
    return this.owd(tx, object);
  }

  // ── Sharing rules ──────────────────────────────────────────────────────────────────────────
  private async ruleDtos(
    tx: TenantTransaction,
    rows: Awaited<ReturnType<TenantTransaction['prisma']['sharingRule']['findMany']>>,
  ): Promise<SharingRule[]> {
    const refs: Principal[] = rows.flatMap((r) => [
      { type: r.targetType, id: r.targetId },
      ...(r.sourceType && r.sourceId ? [{ type: r.sourceType, id: r.sourceId }] : []),
    ]);
    const names = await principalNames(tx, refs);
    const runs = await tx.prisma.jobRun.findMany({
      where: { kind: RULE_CHANGED, subjectId: { in: rows.map((r) => r.id) } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      distinct: ['subjectId'],
    });
    const runOf = new Map(runs.map((r) => [r.subjectId, r]));
    return rows.map((r) => {
      const run = runOf.get(r.id);
      return {
        id: r.id,
        object: r.object,
        name: r.name,
        description: r.description,
        kind: r.kind,
        source:
          r.sourceType && r.sourceId
            ? { type: r.sourceType, id: r.sourceId, name: names.get(r.sourceId) ?? '' }
            : null,
        criteria: r.criteria ?? null,
        target: { type: r.targetType, id: r.targetId, name: names.get(r.targetId) ?? '' },
        access: ruleAccess(r.access),
        active: r.active,
        version: r.version,
        lastRun: run
          ? {
              id: run.id,
              status: run.status,
              done: run.done,
              total: run.total,
              error: run.error,
              createdAt: run.createdAt.toISOString(),
              finishedAt: run.finishedAt?.toISOString() ?? null,
            }
          : null,
      };
    });
  }

  async listRules(tx: TenantTransaction): Promise<{ items: SharingRule[] }> {
    const rows = await tx.prisma.sharingRule.findMany({
      orderBy: [{ object: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    return { items: await this.ruleDtos(tx, rows) };
  }

  async getRule(tx: TenantTransaction, id: string): Promise<SharingRule> {
    const row = await tx.prisma.sharingRule.findFirst({ where: { id } });
    if (!row) throw errors.notFound('Sharing rule');
    const [dto] = await this.ruleDtos(tx, [row]);
    if (!dto) throw errors.notFound('Sharing rule');
    return dto;
  }

  private async assertRuleName(
    tx: TenantTransaction,
    object: string,
    name: string,
    except?: string,
  ) {
    if (
      await tx.prisma.sharingRule.findFirst({
        where: { object, name, ...(except ? { NOT: { id: except } } : {}) },
      })
    )
      throw nameTaken();
  }

  /** Queue the rule's recalculation, tracked by a job_run the Setup page polls. */
  private async recalculate(tx: TenantTransaction, ruleId: string): Promise<void> {
    const run = await tx.prisma.jobRun.create({
      data: {
        tenantId: tx.context.tenantId,
        kind: RULE_CHANGED,
        subjectId: ruleId,
        createdBy: tx.context.userId ?? null,
      },
    });
    await outbox.emit(tx, {
      topic: RULE_CHANGED,
      payload: { ruleId, jobRunId: run.id },
      aggregateType: 'sharing_rule',
      aggregateId: ruleId,
    });
  }

  private async assertRuleObject(tx: TenantTransaction, object: string): Promise<void> {
    if (!standardObject(object)) throw invalid('object', 'Unknown object', 'not_found');
    const { sharingModel } = await this.sharing.orgWideDefault(tx, object);
    if (NO_SHARING.has(sharingModel))
      throw invalid('object', `Sharing rules add nothing while ${object} is ${sharingModel}`);
  }

  async createRule(
    tx: TenantTransaction,
    input: z.infer<typeof CreateSharingRuleRequest>,
  ): Promise<SharingRule> {
    await this.assertRuleObject(tx, input.object);
    if (input.kind === 'OWNER') {
      if (!input.source) throw invalid('source', 'Owner-based rules need a source', 'required');
      if (input.criteria !== undefined)
        throw invalid('criteria', 'Owner-based rules have no criteria');
      await assertPrincipal(tx, 'source', input.source);
    } else {
      if (input.source) throw invalid('source', 'Criteria-based rules have no source');
      if (input.criteria === undefined)
        throw invalid('criteria', 'Criteria-based rules need criteria', 'required');
      assertCriteria(input.object, input.criteria);
    }
    await assertPrincipal(tx, 'target', input.target);
    await this.assertRuleName(tx, input.object, input.name);
    const actor = tx.context.userId ?? null;
    const rule = await tx.prisma.sharingRule.create({
      data: {
        tenantId: tx.context.tenantId,
        object: input.object,
        name: input.name,
        description: input.description ?? null,
        kind: input.kind,
        sourceType: input.source?.type ?? null,
        sourceId: input.source?.id ?? null,
        ...(input.kind === 'CRITERIA' ? { criteria: input.criteria as object } : {}),
        targetType: input.target.type,
        targetId: input.target.id,
        access: ACCESS_NUMBER[input.access],
        active: input.active,
        createdBy: actor,
        updatedBy: actor,
      },
    });
    await this.recalculate(tx, rule.id);
    const after = await this.getRule(tx, rule.id);
    await audit.setup(tx, {
      action: 'sharing.rule_created',
      entityType: 'sharing_rule',
      entityId: rule.id,
      entityName: rule.name,
      after: JSON.parse(JSON.stringify({ ...after, lastRun: undefined })) as Record<string, never>,
    });
    return after;
  }

  async updateRule(
    tx: TenantTransaction,
    id: string,
    input: z.infer<typeof UpdateSharingRuleRequest>,
  ): Promise<SharingRule> {
    const current = await tx.prisma.sharingRule.findFirst({ where: { id } });
    assertVersion(current, input.version, 'Sharing rule');
    if (current.kind === 'OWNER' && input.criteria !== undefined)
      throw invalid('criteria', 'Owner-based rules have no criteria');
    if (current.kind === 'CRITERIA' && input.source)
      throw invalid('source', 'Criteria-based rules have no source');
    if (input.source) await assertPrincipal(tx, 'source', input.source);
    if (input.criteria !== undefined) assertCriteria(current.object, input.criteria);
    if (input.target) await assertPrincipal(tx, 'target', input.target);
    if (input.name) await this.assertRuleName(tx, current.object, input.name, id);
    const before = await this.getRule(tx, id);
    const updated = await tx.prisma.sharingRule.updateMany({
      where: { id, version: input.version },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.source ? { sourceType: input.source.type, sourceId: input.source.id } : {}),
        ...(input.criteria !== undefined ? { criteria: input.criteria as object } : {}),
        ...(input.target ? { targetType: input.target.type, targetId: input.target.id } : {}),
        ...(input.access ? { access: ACCESS_NUMBER[input.access] } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        version: { increment: 1 },
        updatedBy: tx.context.userId ?? null,
      },
    });
    if (updated.count !== 1) assertVersion(null, input.version, 'Sharing rule');
    const affectsShares =
      input.source !== undefined ||
      input.criteria !== undefined ||
      input.target !== undefined ||
      (input.access !== undefined && ACCESS_NUMBER[input.access] !== current.access) ||
      (input.active !== undefined && input.active !== current.active);
    if (affectsShares) await this.recalculate(tx, id);
    const after = await this.getRule(tx, id);
    await audit.setup(tx, {
      action: 'sharing.rule_updated',
      entityType: 'sharing_rule',
      entityId: id,
      entityName: before.name,
      before: JSON.parse(JSON.stringify({ ...before, lastRun: undefined })) as Record<
        string,
        never
      >,
      after: JSON.parse(JSON.stringify({ ...after, lastRun: undefined })) as Record<string, never>,
    });
    return after;
  }

  async removeRule(tx: TenantTransaction, id: string): Promise<void> {
    const rule = await tx.prisma.sharingRule.findFirst({ where: { id } });
    if (!rule) throw errors.notFound('Sharing rule');
    await tx.prisma.sharingRule.delete({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
    });
    await outbox.emit(tx, {
      topic: RULE_DELETED,
      payload: { ruleId: id, object: rule.object },
      aggregateType: 'sharing_rule',
      aggregateId: id,
    });
    await audit.setup(tx, {
      action: 'sharing.rule_deleted',
      entityType: 'sharing_rule',
      entityId: id,
      entityName: rule.name,
      before: { object: rule.object, name: rule.name, kind: rule.kind },
    });
  }

  // ── Manual shares ──────────────────────────────────────────────────────────────────────────
  /** 404 unless the caller can see the record, 403 unless they have Full access to it. */
  private async assertCanShare(tx: TenantTransaction, object: string, recordId: string) {
    if (!standardObject(object)) throw errors.notFound('Record');
    await this.access.assert(tx, tx.context.userId ?? '', { object, action: 'share', recordId });
  }

  async listShares(
    tx: TenantTransaction,
    object: string,
    recordId: string,
  ): Promise<{ items: RecordShare[] }> {
    await this.assertCanShare(tx, object, recordId);
    return this.shares(tx, object, recordId);
  }

  private async shares(
    tx: TenantTransaction,
    object: string,
    recordId: string,
  ): Promise<{ items: RecordShare[] }> {
    const rows = await tx.prisma.recordShare.findMany({
      where: { object, recordId },
      orderBy: [{ access: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    const names = await principalNames(
      tx,
      rows.map((r) => ({ type: r.principalType, id: r.principalId })),
    );
    return {
      items: rows.map((r) => ({
        principal: {
          type: r.principalType,
          id: r.principalId,
          name: names.get(r.principalId) ?? '',
        },
        access: ACCESS_NAME[r.access as 1 | 2 | 3],
        reason: r.reason,
        sourceId: r.sourceId === NIL_UUID ? null : r.sourceId,
      })),
    };
  }

  async share(
    tx: TenantTransaction,
    object: string,
    recordId: string,
    input: z.infer<typeof ManualShareRequest>,
  ): Promise<{ items: RecordShare[] }> {
    await this.assertCanShare(tx, object, recordId);
    if (NO_SHARING.has((await this.sharing.orgWideDefault(tx, object)).sharingModel))
      throw errors.conflict('Records of this object are shared through their org-wide default');
    await assertPrincipal(tx, 'principal', input.principal);
    await grantManualShare(tx.kysely, {
      tenantId: tx.context.tenantId,
      object,
      recordId,
      principal: input.principal,
      access: ACCESS_NUMBER[input.access],
      ...(tx.context.userId ? { createdBy: tx.context.userId } : {}),
    });
    await audit.record(tx, {
      action: 'record.shared',
      object,
      recordId,
      payload: {
        principalType: input.principal.type,
        principalId: input.principal.id,
        access: input.access,
      },
    });
    return this.shares(tx, object, recordId);
  }

  async unshare(
    tx: TenantTransaction,
    object: string,
    recordId: string,
    principal: Principal,
  ): Promise<void> {
    await this.assertCanShare(tx, object, recordId);
    const removed = await revokeManualShare(tx.kysely, {
      tenantId: tx.context.tenantId,
      object,
      recordId,
      principal,
    });
    if (!removed) throw errors.notFound('Share');
    await audit.record(tx, {
      action: 'record.unshared',
      object,
      recordId,
      payload: { principalType: principal.type, principalId: principal.id },
    });
  }
}
