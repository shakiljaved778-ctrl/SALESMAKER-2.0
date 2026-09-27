import { outbox, type TenantTransaction } from '@sm/db';
import { objectAccess } from '@sm/permissions';
import { countQuery, PathFilterSchema } from '@sm/query-engine';
import { z } from 'zod';

import {
  BULK_BATCH,
  MASS_JOB_LIMIT,
  massDelete,
  massTransfer,
  massUpdate,
  selectMatching,
  type RowResult,
} from './bulk.js';
import type { RecordContext } from './context.js';
import { RecordError } from './errors.js';
import { loadRecordContext } from './load-context.js';

/** Mass actions over "select all matching" run on the `import` queue (bulk data work). */
export const MASS_ACTION_TOPIC = 'import.mass_action';
/** Failed rows kept on the job run for the user to review. */
export const MASS_FAILURES_KEPT = 100;

export const MassActionSchema = z
  .object({
    object: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
    /** Either the selected ids or a filter ("select all matching"), never both. */
    ids: z.array(z.uuid()).min(1).max(MASS_JOB_LIMIT).optional(),
    where: PathFilterSchema.optional(),
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('update'), fields: z.record(z.string(), z.unknown()) }).strict(),
      z
        .object({
          kind: z.literal('transfer'),
          ownerId: z.uuid(),
          opportunities: z.enum(['none', 'open', 'all']).optional(),
          keepTeams: z.boolean().optional(),
        })
        .strict(),
      z.object({ kind: z.literal('delete') }).strict(),
    ]),
  })
  .strict()
  .refine((m) => !(m.ids && m.where), { message: 'ids or where, not both' });
export type MassAction = z.infer<typeof MassActionSchema>;

const JobPayload = z.object({ jobRunId: z.uuid(), userId: z.uuid(), spec: MassActionSchema });

/** Refuse up front what would fail on every row: the action's own permission. */
function checkAllowed(ctx: RecordContext, spec: MassAction) {
  const need = (ok: boolean, code: string) => {
    if (!ok) throw new RecordError('forbidden', [{ field: '_record', code }]);
  };
  if (!ctx.metadata.object(spec.object) || !objectAccess(ctx.permissions, spec.object).read)
    throw new RecordError('not_found');
  if (spec.action.kind === 'update')
    need(ctx.permissions.system.has('mass_update'), 'needs_mass_update');
  if (spec.action.kind === 'transfer')
    need(ctx.permissions.system.has('transfer_records'), 'needs_transfer_records');
  if (spec.action.kind === 'delete')
    need(objectAccess(ctx.permissions, spec.object).modifyAll, 'needs_modify_all');
}

/** How many records a mass action would touch (the preview count), capped at the job limit. */
export async function previewMassAction(
  tx: TenantTransaction,
  ctx: RecordContext,
  spec: MassAction,
): Promise<{ count: number; tooMany: boolean }> {
  checkAllowed(ctx, spec);
  if (spec.ids) return { count: spec.ids.length, tooMany: false };
  const { count } = await countQuery(
    tx.kysely,
    { object: spec.object, fields: ['id'], ...(spec.where ? { where: spec.where } : {}) },
    { ...ctx, maxLimit: 2000 },
  );
  return { count, tooMany: count > MASS_JOB_LIMIT };
}

/**
 * Queue a mass action as a job the user can follow (job_run: done, total, failed). The rows are
 * selected when the job runs, as the user, so records they lose access to meanwhile are skipped.
 */
export async function startMassAction(
  tx: TenantTransaction,
  ctx: RecordContext,
  input: unknown,
): Promise<{ jobRunId: string; total: number }> {
  const parsed = MassActionSchema.safeParse(input);
  if (!parsed.success) throw new RecordError('invalid', [{ field: '_body', code: 'invalid' }]);
  const spec = parsed.data;
  const preview = await previewMassAction(tx, ctx, spec);
  if (preview.tooMany)
    throw new RecordError('invalid', [{ field: '_selection', code: 'selection_too_large' }]);
  const run = await tx.prisma.jobRun.create({
    data: {
      tenantId: tx.context.tenantId,
      kind: `mass_${spec.action.kind}`,
      total: preview.count,
      createdBy: ctx.userId,
    },
  });
  await outbox.emit(tx, {
    topic: MASS_ACTION_TOPIC,
    aggregateType: 'job_run',
    aggregateId: run.id,
    payload: JSON.parse(JSON.stringify({ jobRunId: run.id, userId: ctx.userId, spec })) as Record<
      string,
      never
    >,
  });
  return { jobRunId: run.id, total: preview.count };
}

function applyBatch(
  tx: TenantTransaction,
  ctx: RecordContext,
  spec: MassAction,
  ids: readonly string[],
): Promise<RowResult[]> {
  switch (spec.action.kind) {
    case 'update':
      return massUpdate(tx, ctx, spec.object, ids, { fields: spec.action.fields });
    case 'transfer':
      return massTransfer(tx, ctx, spec.object, ids, spec.action.ownerId, {
        ...(spec.action.opportunities ? { opportunities: spec.action.opportunities } : {}),
        ...(spec.action.keepTeams !== undefined ? { keepTeams: spec.action.keepTeams } : {}),
      });
    case 'delete':
      return massDelete(tx, ctx, spec.object, ids);
  }
}

/**
 * Run a queued mass action: select the rows as the user, then one transaction per batch of 200,
 * recording progress after each. A retried job starts over; rows already done are no-ops or no
 * longer match. A job already finished is not run again.
 */
export async function runMassAction(
  inTenant: <T>(fn: (tx: TenantTransaction) => Promise<T>) => Promise<T>,
  payload: unknown,
  options: { now?: () => Date } = {},
): Promise<void> {
  const { jobRunId, userId, spec } = JobPayload.parse(payload);
  const context = (tx: TenantTransaction) =>
    loadRecordContext(tx, userId, options.now ? { now: options.now } : {});
  const setRun = (data: Parameters<TenantTransaction['prisma']['jobRun']['update']>[0]['data']) =>
    inTenant((tx) =>
      tx.prisma.jobRun.update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id: jobRunId } },
        data,
      }),
    );
  const run = await inTenant((tx) => tx.prisma.jobRun.findFirst({ where: { id: jobRunId } }));
  if (!run || run.status === 'SUCCEEDED') return;
  await setRun({
    status: 'RUNNING',
    startedAt: new Date(),
    done: 0,
    failed: 0,
    error: null,
    result: { failures: [] },
  });
  try {
    const ids = await inTenant(async (tx) => {
      const ctx = await context(tx);
      checkAllowed(ctx, spec);
      return spec.ids ? [...spec.ids] : selectMatching(tx, ctx, spec.object, spec.where);
    });
    let done = 0;
    let failed = 0;
    const failures: { id: string | null; status: number; errors: string[] }[] = [];
    for (let i = 0; i < ids.length; i += BULK_BATCH) {
      const batch = ids.slice(i, i + BULK_BATCH);
      const results = await inTenant(async (tx) => applyBatch(tx, await context(tx), spec, batch));
      for (const r of results) {
        done += 1;
        if (r.ok) continue;
        failed += 1;
        if (failures.length < MASS_FAILURES_KEPT)
          failures.push({
            id: r.id,
            status: r.status,
            errors: r.errors.map((e) => `${e.field}:${e.code}`),
          });
      }
      await setRun({ done, failed, total: ids.length, result: { failures } });
    }
    await setRun({ status: 'SUCCEEDED', finishedAt: new Date() });
  } catch (err) {
    await setRun({
      status: 'FAILED',
      finishedAt: new Date(),
      error: err instanceof RecordError ? err.code : 'internal_error',
    });
    if (!(err instanceof RecordError)) throw err;
  }
}
