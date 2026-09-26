import { visibility, withTenant, type CellPrisma } from '@sm/db';
import {
  recalculateRule,
  removeRuleShares,
  type Db,
  type SharingRuleDefinition,
} from '@sm/query-engine';
import { z } from 'zod';

import type { JobHandler } from './jobs.js';

/** Recompute owner visibility after a hierarchy, manager or queue change (§6.4). */
export const VISIBILITY_CHANGED = 'sharing.visibility_changed';
/** Recalculate one sharing rule's shares over its object (created, edited, (de)activated). */
export const RULE_CHANGED = 'sharing.rule_changed';
/** Remove the shares of a deleted rule. */
export const RULE_DELETED = 'sharing.rule_deleted';

const VisibilityPayload = z.object({
  /** Viewers to recompute; omitted means every user of the tenant. */
  viewers: z.array(z.uuid()).optional(),
});
const RuleChangedPayload = z.object({ ruleId: z.uuid(), jobRunId: z.uuid().optional() });
const RuleDeletedPayload = z.object({ ruleId: z.uuid(), object: z.string().min(1) });

export interface SharingHandlerOptions {
  /**
   * The table holding an object's records. Standard objects get their tables in P02 (named after
   * the object); custom objects live in custom_record then.
   */
  recordTable?: (object: string) => string;
  batchSize?: number;
}

const LONG = { statementTimeoutMs: 60_000, timeoutMs: 120_000 };

async function runRecalculation(
  prisma: CellPrisma,
  tenantId: string,
  payload: z.infer<typeof RuleChangedPayload>,
  options: Required<SharingHandlerOptions>,
): Promise<void> {
  const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(prisma, { tenantId }, fn, LONG);
  const stored = await inTenant(({ prisma: tx }) =>
    tx.sharingRule.findUnique({ where: { tenantId_id: { tenantId, id: payload.ruleId } } }),
  );
  if (!stored) return; // deleted since: its rule_deleted job removes the shares
  const jobRunId =
    payload.jobRunId ??
    (
      await inTenant(({ prisma: tx }) =>
        tx.jobRun.create({ data: { tenantId, kind: RULE_CHANGED, subjectId: stored.id } }),
      )
    ).id;
  const setRun = (data: Parameters<CellPrisma['jobRun']['update']>[0]['data']) =>
    inTenant(({ prisma: tx }) =>
      tx.jobRun.update({ where: { tenantId_id: { tenantId, id: jobRunId } }, data }),
    );
  await setRun({ status: 'RUNNING', startedAt: new Date(), error: null });
  const table = options.recordTable(stored.object);
  // An object whose records have no table yet (standard objects before P02) has nothing to
  // share: the rule is up to date with zero records.
  const exists = await inTenant(
    ({ prisma: tx }) =>
      tx.$queryRaw<{ ok: boolean }[]>`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS ok`,
  );
  if (exists[0]?.ok !== true) {
    await setRun({ status: 'SUCCEEDED', done: 0, total: 0, finishedAt: new Date() });
    return;
  }
  const rule: SharingRuleDefinition = {
    id: stored.id,
    object: stored.object,
    kind: stored.kind,
    sourceType: stored.sourceType,
    sourceId: stored.sourceId,
    criteria: stored.criteria,
    targetType: stored.targetType,
    targetId: stored.targetId,
    access: stored.access,
    active: stored.active,
  };
  try {
    const result = await recalculateRule((fn) => inTenant((tx) => fn(tx.kysely as unknown as Db)), {
      tenantId,
      rule,
      recordTable: table,
      batchSize: options.batchSize,
      onProgress: async ({ done, total }) => {
        await setRun({ done, total });
      },
    });
    await setRun({
      status: 'SUCCEEDED',
      done: result.done,
      total: result.total,
      finishedAt: new Date(),
    });
  } catch (err) {
    await setRun({ status: 'FAILED', error: (err as Error).message, finishedAt: new Date() });
    throw err;
  }
}

/** Sharing recalculation jobs (§6.4). Each runs in its tenant's transactions. */
export function createSharingHandler(options: SharingHandlerOptions = {}): JobHandler {
  const resolved: Required<SharingHandlerOptions> = {
    recordTable: options.recordTable ?? ((object) => object),
    batchSize: options.batchSize ?? 1000,
  };
  return async (envelope, { prisma, logger }) => {
    const { tenantId } = envelope;
    if (!tenantId) throw new Error(`${envelope.topic} needs a tenant`);
    switch (envelope.topic) {
      case VISIBILITY_CHANGED: {
        const { viewers } = VisibilityPayload.parse(envelope.payload);
        const rows = await withTenant(
          prisma,
          { tenantId },
          (tx) => visibility.rebuild(tx, viewers),
          LONG,
        );
        logger.info({ viewers: viewers?.length ?? 'all', rows }, 'owner visibility rebuilt');
        return;
      }
      case RULE_CHANGED:
        await runRecalculation(
          prisma,
          tenantId,
          RuleChangedPayload.parse(envelope.payload),
          resolved,
        );
        return;
      case RULE_DELETED: {
        const { ruleId, object } = RuleDeletedPayload.parse(envelope.payload);
        const removed = await withTenant(prisma, { tenantId }, (tx) =>
          removeRuleShares(tx.kysely as unknown as Db, { tenantId, object, ruleId }),
        );
        logger.info({ ruleId, removed }, 'sharing rule shares removed');
        return;
      }
      default:
        throw new Error(`unknown sharing job ${envelope.topic}`);
    }
  };
}

export const sharingHandler = createSharingHandler();
