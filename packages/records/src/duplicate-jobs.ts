import { loadTenantMetadata, type TenantTransaction } from '@sm/db';
import { MetadataIndex } from '@sm/metadata';
import { sql } from 'kysely';

import { queueStoredPairs, type MatchCondition } from './duplicates.js';
import { ident } from './storage.js';

/** Run one duplicate job (payload `{ jobId }`), on the maintenance queue. */
export const DUPLICATE_SCAN_TOPIC = 'maintenance.duplicate_scan';
/** Start the tenant's scheduled duplicate jobs that are due (hourly, every tenant). */
export const DUPLICATE_SCHEDULE_TOPIC = 'maintenance.duplicate_schedule';

const SCAN_BATCH = 500;
const DAY = 86_400_000;

type InTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>) => Promise<T>;

/** When a scheduled job runs next, from when it last ran. */
export function nextRun(schedule: string | null, from: Date): Date | null {
  if (schedule === 'daily') return new Date(from.getTime() + DAY);
  if (schedule === 'weekly') return new Date(from.getTime() + 7 * DAY);
  return null;
}

/**
 * Scan a tenant's live records of the job's object with its matching rule (§7.2): keyset batches
 * of 500, each in its own transaction, every pair found going to the review queue once. Runs in
 * system context (the queue shows each user only groups they can see). Returns what it did; a
 * job that is not queued (already running or finished) is left alone.
 */
export async function runDuplicateJob(
  inTenant: InTenant,
  jobId: string,
  options: { batch?: number; now?: () => Date } = {},
): Promise<{ scanned: number; found: number } | null> {
  const now = options.now ?? (() => new Date());
  const batch = options.batch ?? SCAN_BATCH;
  const started = await inTenant(async (tx) => {
    const claimed = await tx.prisma.duplicateJob.updateMany({
      where: { id: jobId, status: 'QUEUED' },
      data: { status: 'RUNNING', startedAt: now(), scanned: 0, found: 0, finishedAt: null },
    });
    if (claimed.count === 0) return null;
    const job = await tx.prisma.duplicateJob.findFirstOrThrow({ where: { id: jobId } });
    const rule = await tx.prisma.matchingRule.findFirst({ where: { id: job.matchingRuleId } });
    const settings = await tx.prisma.tenantSettings.findUniqueOrThrow({
      where: { tenantId: tx.context.tenantId },
    });
    const metadata = new MetadataIndex(await loadTenantMetadata(tx, settings.metadataVersion));
    return { job, rule, object: metadata.object(job.object) };
  });
  if (!started) return null;
  const { job, rule, object } = started;
  let scanned = 0;
  let found = 0;
  try {
    if (rule && object) {
      const definition = {
        id: rule.id,
        name: rule.name,
        object: rule.object,
        conditions: rule.conditions as unknown as MatchCondition[],
        matchBlank: rule.matchBlank,
      };
      let after = '00000000-0000-0000-0000-000000000000';
      for (;;) {
        const step = await inTenant(async (tx) => {
          const ids = await sql<{ id: string }>`
            SELECT id FROM ${sql.table(ident(object.table))}
            WHERE tenant_id = ${tx.context.tenantId}::uuid AND id > ${after}::uuid
              AND deleted_at IS NULL AND merged_into_id IS NULL
            ORDER BY id LIMIT ${batch}`.execute(tx.kysely);
          const list = ids.rows.map((r) => r.id);
          const added = await queueStoredPairs(tx, object, definition, list, jobId);
          await tx.prisma.duplicateJob.update({
            where: { tenantId_id: { tenantId: tx.context.tenantId, id: jobId } },
            data: { scanned: { increment: list.length }, found: { increment: added } },
          });
          return { list, added };
        });
        scanned += step.list.length;
        found += step.added;
        const last = step.list.at(-1);
        if (!last || step.list.length < batch) break;
        after = last;
      }
    }
    const finished = now();
    await inTenant((tx) =>
      tx.prisma.duplicateJob.update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id: jobId } },
        data: {
          status: rule && object ? 'SUCCEEDED' : 'FAILED',
          finishedAt: finished,
          nextRunAt: nextRun(job.schedule, finished),
        },
      }),
    );
    return { scanned, found };
  } catch (err) {
    await inTenant((tx) =>
      tx.prisma.duplicateJob.update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id: jobId } },
        data: { status: 'FAILED', finishedAt: now(), nextRunAt: nextRun(job.schedule, now()) },
      }),
    );
    throw err;
  }
}

/** Queue and run the tenant's scheduled jobs that are due. Returns the jobs run. */
export async function runDueDuplicateJobs(
  inTenant: InTenant,
  options: { now?: () => Date } = {},
): Promise<number> {
  const now = options.now ?? (() => new Date());
  const due = await inTenant(async (tx) => {
    const jobs = await tx.prisma.duplicateJob.findMany({
      where: {
        schedule: { not: null },
        nextRunAt: { lte: now() },
        status: { in: ['SUCCEEDED', 'FAILED'] },
      },
      select: { id: true },
    });
    await tx.prisma.duplicateJob.updateMany({
      where: { id: { in: jobs.map((j) => j.id) } },
      data: { status: 'QUEUED' },
    });
    return jobs.map((j) => j.id);
  });
  for (const id of due) await runDuplicateJob(inTenant, id, { now });
  return due.length;
}
