import type { TenantTransaction } from '@sm/db';
import { storageKey, type StorageProvider } from '@sm/integrations';
import {
  bulkDelete,
  bulkInsert,
  bulkUpdate,
  findMatches,
  loadRecordContext,
  RecordError,
  type FieldError,
  type MatchCondition,
  type RecordContext,
  type RowResult,
} from '@sm/records';
import { sql } from 'kysely';

import { mapRow, type ColumnMapping, type MappedRow } from './mapping.js';
import { readRows, type FileType } from './parse.js';

/** Import jobs on the `import` queue (§7.1). Payload `{ jobId }`. */
export const IMPORT_RUN_TOPIC = 'import.run';
export const IMPORT_DRY_RUN_TOPIC = 'import.dry_run';
export const IMPORT_UNDO_TOPIC = 'import.undo';

/** Rows per transaction: one `bulkInsert` call. */
export const IMPORT_BATCH = 1000;
/** Rows a dry run looks at. */
export const DRY_RUN_ROWS = 100;
/** Imports can be undone this long after they finish. */
export const UNDO_HOURS = 72;
/** Retries of a batch that lost a deadlock or a serialization race. */
const RETRIES = 3;

export type InTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>) => Promise<T>;

export interface ImportDeps {
  inTenant: InTenant;
  storage: StorageProvider;
  now?: () => Date;
}

interface RowOutcome {
  rowNumber: number;
  status: 'CREATED' | 'UPDATED' | 'SKIPPED' | 'FAILED';
  recordId: string | null;
  errors: FieldError[];
}

/** A dry run's transaction is rolled back by throwing this, carrying what it found. */
class DryRunDone extends Error {
  constructor(readonly outcomes: RowOutcome[]) {
    super('dry run');
  }
}

/** The SQLSTATE of a database error, however the driver wrapped it. */
function sqlState(err: unknown): string | null {
  const e = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown } | null;
  if (typeof e?.meta?.code === 'string') return e.meta.code;
  const m = /Code: `([0-9A-Z]{5})`/.exec(typeof e?.message === 'string' ? e.message : '');
  return m?.[1] ?? (typeof e?.code === 'string' && !e.code.startsWith('P') ? e.code : null);
}

/** Run a batch, again when it lost a deadlock (40P01) or a serialization race (40001). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const state = sqlState(err);
      if (attempt >= RETRIES || (state !== '40P01' && state !== '40001')) throw err;
      await new Promise((r) => setTimeout(r, 50 * attempt * attempt));
    }
  }
}

interface Job {
  id: string;
  object: string;
  fileKey: string;
  fileType: string;
  sheet: string | null;
  headerRow: number;
  mapping: unknown;
  duplicateMode: 'SKIP' | 'UPDATE' | 'CREATE';
  matchingRuleId: string | null;
  runAssignment: boolean;
  assignmentRuleId: string | null;
  defaults: unknown;
  createdBy: string | null;
}

/** Owners by email or name (active users), resolved once per batch. */
async function resolveOwners(tx: TenantTransaction, rows: MappedRow[]) {
  const wanted = rows.flatMap((r) => (r.owner ? [r.owner] : []));
  if (wanted.length === 0) return;
  const users = await tx.prisma.user.findMany({
    where: { status: 'ACTIVE', deletedAt: null },
    select: { id: true, email: true, name: true },
  });
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));
  const byName = new Map<string, string | null>();
  for (const u of users) {
    const key = u.name.toLowerCase();
    // Two users with one name: ambiguous, never guessed.
    byName.set(key, byName.has(key) ? null : u.id);
  }
  for (const r of rows) {
    if (!r.owner) continue;
    const id = r.owner.by === 'email' ? byEmail.get(r.owner.key) : byName.get(r.owner.key);
    if (id) r.input.fields['owner_id'] = id;
    else
      r.errors.push({ field: 'owner_id', code: id === null ? 'ambiguous_owner' : 'unknown_owner' });
  }
}

/** One batch through the duplicate mode and RecordService, as the importing user. */
async function processBatch(
  tx: TenantTransaction,
  ctx: RecordContext,
  job: Job,
  rows: MappedRow[],
): Promise<RowOutcome[]> {
  const object = ctx.metadata.object(job.object);
  if (!object) throw new RecordError('not_found');
  await resolveOwners(tx, rows);
  const outcomes = new Map<number, RowOutcome>();
  const fail = (r: MappedRow, errors: FieldError[]) =>
    outcomes.set(r.rowNumber, { rowNumber: r.rowNumber, status: 'FAILED', recordId: null, errors });
  const valid = rows.filter((r) => {
    if (r.errors.length) fail(r, r.errors);
    return r.errors.length === 0;
  });

  // SKIP and UPDATE: rows matching existing records under the job's matching rule.
  let toCreate = valid;
  if (job.duplicateMode !== 'CREATE' && job.matchingRuleId) {
    const rule = await tx.prisma.matchingRule.findFirst({ where: { id: job.matchingRuleId } });
    if (rule) {
      const matches = await findMatches(
        tx,
        ctx,
        object,
        {
          id: rule.id,
          name: rule.name,
          object: rule.object,
          conditions: rule.conditions as unknown as MatchCondition[],
          matchBlank: rule.matchBlank,
        },
        valid.map((r) => ({ index: r.rowNumber, id: null, values: r.input.fields })),
      );
      const updates: { row: MappedRow; id: string }[] = [];
      toCreate = [];
      for (const r of valid) {
        const found = matches.get(r.rowNumber) ?? [];
        if (found.length === 0) toCreate.push(r);
        else if (job.duplicateMode === 'SKIP')
          outcomes.set(r.rowNumber, {
            rowNumber: r.rowNumber,
            status: 'SKIPPED',
            recordId: found.find((m) => m.visible)?.id ?? null,
            errors: [{ field: '_record', code: 'duplicate' }],
          });
        else {
          // UPDATE: the best match the importer can see; one they cannot see is not touched.
          const target = found.find((m) => m.visible && m.id);
          if (target?.id) updates.push({ row: r, id: target.id });
          else fail(r, [{ field: '_record', code: 'duplicate_not_visible' }]);
        }
      }
      for (let i = 0; i < updates.length; i += 200) {
        const slice = updates.slice(i, i + 200);
        const results = await bulkUpdate(
          tx,
          ctx,
          job.object,
          slice.map((u) => ({ id: u.id, input: u.row.input, version: null })),
        );
        for (const [j, res] of results.entries()) {
          const row = slice[j]?.row;
          if (!row) continue;
          outcomes.set(
            row.rowNumber,
            res.ok
              ? { rowNumber: row.rowNumber, status: 'UPDATED', recordId: res.id, errors: [] }
              : {
                  rowNumber: row.rowNumber,
                  status: 'FAILED',
                  recordId: res.id,
                  errors: res.errors,
                },
          );
        }
      }
    }
  }

  if (toCreate.length) {
    const results: RowResult[] = await bulkInsert(
      tx,
      ctx,
      job.object,
      toCreate.map((r) => r.input),
      {
        duplicates: job.duplicateMode === 'CREATE' ? 'skip' : 'enforce',
        ...(job.runAssignment
          ? { assign: { source: 'import', ruleId: job.assignmentRuleId } }
          : {}),
      },
    );
    for (const [i, res] of results.entries()) {
      const row = toCreate[i];
      if (!row) continue;
      outcomes.set(
        row.rowNumber,
        res.ok
          ? { rowNumber: row.rowNumber, status: 'CREATED', recordId: res.id, errors: [] }
          : { rowNumber: row.rowNumber, status: 'FAILED', recordId: null, errors: res.errors },
      );
    }
  }
  return rows.map((r) => outcomes.get(r.rowNumber) as RowOutcome);
}

/** The file's data rows (after the header row, blank rows left out), mapped, in batches. */
async function* batches(
  deps: ImportDeps,
  job: Job,
  ctxObject: Parameters<typeof mapRow>[0],
  size: number,
  limit?: number,
) {
  const stream = await deps.storage.getObject(job.fileKey);
  let line = 0;
  let taken = 0;
  let batch: MappedRow[] = [];
  const mapping = job.mapping as ColumnMapping[];
  const defaults = (job.defaults ?? {}) as Record<string, unknown>;
  for await (const cells of readRows(stream, job.fileType as FileType, job.sheet)) {
    line += 1;
    if (line <= job.headerRow) continue;
    // Wholly blank rows (trailing ones, separators) are not data; XLSX already drops them.
    if (cells.every((c) => c.trim() === '')) continue;
    batch.push(mapRow(ctxObject, mapping, cells, line, defaults));
    taken += 1;
    if (batch.length >= size || (limit !== undefined && taken >= limit)) {
      yield batch;
      batch = [];
    }
    if (limit !== undefined && taken >= limit) return;
  }
  if (batch.length) yield batch;
}

async function loadJob(inTenant: InTenant, jobId: string) {
  return inTenant((tx) => tx.prisma.importJob.findFirst({ where: { id: jobId } }));
}

/**
 * Dry run (§7.1): the first 100 rows through everything a real run does, in a transaction that
 * is rolled back, so the user sees exactly what would happen. Stored on the job as `dry_run`.
 */
export async function dryRunImport(deps: ImportDeps, jobId: string): Promise<void> {
  const job = await loadJob(deps.inTenant, jobId);
  if (!job?.createdBy) return;
  const userId = job.createdBy;
  let outcomes: RowOutcome[] = [];
  try {
    await deps.inTenant(async (tx) => {
      const ctx = await loadRecordContext(tx, userId, deps.now ? { now: deps.now } : {});
      const object = ctx.metadata.object(job.object);
      if (!object) throw new RecordError('not_found');
      const all: RowOutcome[] = [];
      for await (const rows of batches(deps, job, object, DRY_RUN_ROWS, DRY_RUN_ROWS))
        all.push(...(await processBatch(tx, ctx, job, rows)));
      throw new DryRunDone(all);
    });
  } catch (err) {
    if (!(err instanceof DryRunDone)) throw err;
    outcomes = err.outcomes;
  }
  const count = (s: RowOutcome['status']) => outcomes.filter((o) => o.status === s).length;
  await deps.inTenant((tx) =>
    tx.prisma.importJob.update({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id: jobId } },
      data: {
        status: 'READY',
        dryRun: {
          rows: outcomes.length,
          created: count('CREATED'),
          updated: count('UPDATED'),
          skipped: count('SKIPPED'),
          failed: count('FAILED'),
          // Only what went wrong, row by row; never field values.
          problems: outcomes
            .filter((o) => o.status === 'FAILED' || o.status === 'SKIPPED')
            .slice(0, 100)
            .map((o) => ({
              row: o.rowNumber,
              status: o.status,
              errors: o.errors.map((e) => `${e.field}:${e.code}`),
            })),
        },
      },
    }),
  );
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * Run a queued import (§7.1): batches of 1,000 through RecordService as the importing user, each
 * its own transaction (retried on deadlocks), per-row results kept and counted as it goes, then a
 * results file. A job that is not QUEUED is left alone, so a redelivered job never runs twice.
 */
export async function runImport(deps: ImportDeps, jobId: string, options: { batch?: number } = {}) {
  const now = deps.now ?? (() => new Date());
  const claimed = await deps.inTenant(async (tx) => {
    const n = await tx.prisma.importJob.updateMany({
      where: { id: jobId, status: 'QUEUED' },
      data: {
        status: 'RUNNING',
        startedAt: now(),
        processed: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
      },
    });
    return n.count === 1 ? tx.prisma.importJob.findFirst({ where: { id: jobId } }) : null;
  });
  if (!claimed?.createdBy) return;
  const job = claimed;
  const userId = claimed.createdBy;
  try {
    const object = await deps.inTenant(async (tx) => {
      const ctx = await loadRecordContext(tx, userId);
      return ctx.metadata.object(job.object);
    });
    if (!object) throw new RecordError('not_found');
    let total = 0;
    for await (const rows of batches(deps, job, object, options.batch ?? IMPORT_BATCH)) {
      const outcomes = await withRetry(() =>
        deps.inTenant(async (tx) => {
          const ctx = await loadRecordContext(tx, userId);
          const out = await processBatch(tx, ctx, job, rows);
          await tx.prisma.importRowResult.createMany({
            data: out.map((o) => ({
              tenantId: tx.context.tenantId,
              importJobId: jobId,
              rowNumber: o.rowNumber,
              status: o.status,
              recordId: o.recordId,
              errors: o.errors.length ? (o.errors as never) : undefined,
            })),
          });
          const count = (s: RowOutcome['status']) => out.filter((o) => o.status === s).length;
          await tx.prisma.importJob.update({
            where: { tenantId_id: { tenantId: tx.context.tenantId, id: jobId } },
            data: {
              processed: { increment: out.length },
              created: { increment: count('CREATED') },
              updated: { increment: count('UPDATED') },
              skipped: { increment: count('SKIPPED') },
              failed: { increment: count('FAILED') },
            },
          });
          return out;
        }),
      );
      total += outcomes.length;
    }
    const resultKey = await writeResults(deps, job, jobId);
    await deps.inTenant((tx) =>
      tx.prisma.importJob.update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id: jobId } },
        data: { status: 'COMPLETED', total, finishedAt: now(), resultFileKey: resultKey },
      }),
    );
  } catch (err) {
    await deps.inTenant((tx) =>
      tx.prisma.importJob.update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id: jobId } },
        data: {
          status: 'FAILED',
          finishedAt: now(),
          error:
            err instanceof RecordError
              ? err.code
              : err instanceof Error
                ? err.message.slice(0, 200)
                : 'failed',
        },
      }),
    );
    if (
      !(err instanceof RecordError) &&
      !(err instanceof Error && /^no (sheet|object)|not an XLSX/.test(err.message))
    )
      throw err;
  }
}

/** The results file: one line per row (number, status, record id, errors), CSV. */
async function writeResults(deps: ImportDeps, job: { id: string }, jobId: string): Promise<string> {
  const lines = ['row,status,record_id,errors'];
  let after = 0;
  const tenantId = await deps.inTenant((tx) => Promise.resolve(tx.context.tenantId));
  for (;;) {
    const rows = await deps.inTenant((tx) =>
      tx.prisma.importRowResult.findMany({
        where: { importJobId: jobId, rowNumber: { gt: after } },
        orderBy: { rowNumber: 'asc' },
        take: 5000,
      }),
    );
    for (const r of rows) {
      const errors = ((r.errors ?? []) as unknown as FieldError[])
        .map((e) => `${e.field}:${e.code}`)
        .join('; ');
      lines.push([String(r.rowNumber), r.status, r.recordId ?? '', csvCell(errors)].join(','));
    }
    const last = rows.at(-1);
    if (!last || rows.length < 5000) break;
    after = last.rowNumber;
  }
  const key = storageKey(tenantId, `import-${job.id}-results.csv`);
  await deps.storage.putObject(key, Buffer.from(`${lines.join('\n')}\n`), 'text/csv');
  return key;
}

/**
 * Undo an import within 72 hours (§7.1): the records it created go to the recycle bin, as the
 * importing user (records they can no longer delete stay, and are counted). Updated records are
 * not reverted: their history shows what the import changed.
 */
export async function undoImport(
  deps: ImportDeps,
  jobId: string,
): Promise<{ deleted: number; kept: number } | null> {
  const now = deps.now ?? (() => new Date());
  const job = await deps.inTenant(async (tx) => {
    const n = await tx.prisma.importJob.updateMany({
      where: {
        id: jobId,
        status: 'UNDOING',
      },
      data: { status: 'UNDOING' },
    });
    return n.count === 1 ? tx.prisma.importJob.findFirst({ where: { id: jobId } }) : null;
  });
  if (!job?.createdBy) return null;
  const userId = job.createdBy;
  let deleted = 0;
  let kept = 0;
  let after = 0;
  for (;;) {
    const rows = await deps.inTenant((tx) =>
      tx.prisma.importRowResult.findMany({
        where: {
          importJobId: jobId,
          status: 'CREATED',
          rowNumber: { gt: after },
          recordId: { not: null },
        },
        orderBy: { rowNumber: 'asc' },
        take: 200,
      }),
    );
    if (rows.length === 0) break;
    const results = await withRetry(() =>
      deps.inTenant(async (tx) => {
        const ctx = await loadRecordContext(tx, userId);
        // Already deleted (or merged) records are simply gone.
        const live = new Set(
          (
            await sql<{
              id: string;
            }>`SELECT id FROM ${sql.table(job.object)} WHERE tenant_id = ${tx.context.tenantId}::uuid
              AND id = ANY (${sql.val(rows.map((r) => r.recordId ?? ''))}::uuid[]) AND deleted_at IS NULL`.execute(
              tx.kysely,
            )
          ).rows.map((r) => r.id),
        );
        return bulkDelete(
          tx,
          ctx,
          job.object,
          rows.flatMap((r) => (r.recordId && live.has(r.recordId) ? [r.recordId] : [])),
        );
      }),
    );
    deleted += results.filter((r) => r.ok).length;
    kept += results.filter((r) => !r.ok).length;
    after = rows.at(-1)?.rowNumber ?? after;
  }
  await deps.inTenant((tx) =>
    tx.prisma.importJob.update({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id: jobId } },
      data: { status: 'UNDONE', undoneAt: now() },
    }),
  );
  return { deleted, kept };
}

/** Whether a finished import may still be undone. */
export function undoable(
  job: { status: string; finishedAt: Date | null },
  now = new Date(),
): boolean {
  return (
    job.status === 'COMPLETED' &&
    job.finishedAt !== null &&
    now.getTime() - job.finishedAt.getTime() <= UNDO_HOURS * 3_600_000
  );
}
