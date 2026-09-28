import { loadTenantMetadata, type TenantTransaction } from '@sm/db';
import { MetadataIndex } from '@sm/metadata';
import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';

import { hasMoney, ident } from './storage.js';

/** Recalculate corporate amounts after a dated rate changed (Q13, ADR-0031). */
export const CURRENCY_RECALC_TOPIC = 'maintenance.currency_recalc';

const Payload = z.object({ jobRunId: z.uuid(), code: z.string().length(3), date: z.iso.date() });
export type CurrencyRecalcPayload = z.infer<typeof Payload>;

const BATCH = 1000;

/**
 * Which corporate amounts a rate change on `date` moves, and nothing else:
 *
 * - An opportunity's amount converts at its close date, so every opportunity in the currency
 *   closing on or after `date` and before the next rate date is recomputed with the rate now in
 *   force on its close date.
 * - Other money converts on the day it was set, which is not stored; what is stored is the rate
 *   date used (`corporate_rate_date`). Records converted with the rate dated `date` (it was
 *   corrected or removed) are recomputed with the rate now in force on that date. A rate added
 *   between two existing dates leaves them alone: which of them were set after it is unknown.
 *
 * Corporate amounts are derived values: the write bumps no version, history or audit per record
 * (the rate change itself is audited in Setup). Each batch is its own transaction.
 */
export async function recalculateCorporateAmounts(
  inTenant: <T>(fn: (tx: TenantTransaction) => Promise<T>) => Promise<T>,
  payload: unknown,
): Promise<number> {
  const { jobRunId, code, date } = Payload.parse(payload);
  const setRun = (data: Parameters<TenantTransaction['prisma']['jobRun']['update']>[0]['data']) =>
    inTenant((tx) =>
      tx.prisma.jobRun.update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id: jobRunId } },
        data,
      }),
    );
  const run = await inTenant((tx) => tx.prisma.jobRun.findFirst({ where: { id: jobRunId } }));
  if (!run || run.status === 'SUCCEEDED') return 0;
  await setRun({ status: 'RUNNING', startedAt: new Date(), done: 0, error: null });
  try {
    const plan = await inTenant(async (tx) => {
      const settings = await tx.prisma.tenantSettings.findUniqueOrThrow({
        where: { tenantId: tx.context.tenantId },
        select: { metadataVersion: true },
      });
      const metadata = new MetadataIndex(await loadTenantMetadata(tx, settings.metadataVersion));
      const next = await tx.prisma.currencyRate.findFirst({
        where: { code, effectiveDate: { gt: new Date(date) } },
        orderBy: { effectiveDate: 'asc' },
        select: { effectiveDate: true },
      });
      return {
        objects: metadata.metadata.objects.filter(hasMoney).map((o) => ({
          apiName: o.apiName,
          table: o.table,
          money: o.fields
            .filter((f) => f.isStandard && f.type === 'currency' && f.storage.kind === 'column')
            .map((f) => f.apiName),
        })),
        nextDate: next ? next.effectiveDate.toISOString().slice(0, 10) : null,
      };
    });
    let done = 0;
    for (const object of plan.objects) {
      let after = '00000000-0000-0000-0000-000000000000';
      for (;;) {
        const ids = await inTenant((tx) =>
          object.apiName === 'opportunity'
            ? recomputeByCloseDate(tx, code, date, plan.nextDate, after)
            : recomputeByRateDate(tx, object.table, object.money, code, date, after),
        );
        done += ids.length;
        if (ids.length < BATCH) break;
        after = ids.at(-1) ?? after;
        await setRun({ done });
      }
    }
    await setRun({ status: 'SUCCEEDED', done, total: done, finishedAt: new Date() });
    return done;
  } catch (err) {
    await setRun({ status: 'FAILED', error: 'internal_error', finishedAt: new Date() });
    throw err;
  }
}

/** The rate in force on a date (the latest on or before it), as SQL over a record alias. */
const rateOn = (tenantId: string, code: string, on: RawBuilder<unknown>) => sql`
  LEFT JOIN LATERAL (
    SELECT c.rate, c.effective_date FROM currency_rate c
     WHERE c.tenant_id = ${tenantId}::uuid AND c.code = ${code} AND c.effective_date <= ${on}
     ORDER BY c.effective_date DESC LIMIT 1) r ON TRUE`;

async function recomputeByCloseDate(
  tx: TenantTransaction,
  code: string,
  from: string,
  until: string | null,
  after: string,
): Promise<string[]> {
  const t = tx.context.tenantId;
  const rows = await sql<{ id: string }>`
    WITH target AS (
      SELECT o.id, r.rate, r.effective_date FROM opportunity o
      ${rateOn(t, code, sql`o.close_date`)}
      WHERE o.tenant_id = ${t}::uuid AND o.currency_code = ${code} AND o.id > ${after}::uuid
        AND o.close_date >= ${from}::date
        ${until ? sql`AND o.close_date < ${until}::date` : sql``}
      ORDER BY o.id LIMIT ${BATCH})
    UPDATE opportunity o
       SET amount_corporate = CASE WHEN target.rate IS NULL OR o.amount IS NULL THEN NULL
                                   ELSE round(o.amount / target.rate, 2) END,
           corporate_rate_date = target.effective_date
      FROM target
     WHERE o.tenant_id = ${t}::uuid AND o.id = target.id
    RETURNING o.id`.execute(tx.kysely);
  return rows.rows.map((r) => r.id).sort();
}

async function recomputeByRateDate(
  tx: TenantTransaction,
  table: string,
  money: readonly string[],
  code: string,
  date: string,
  after: string,
): Promise<string[]> {
  if (money.length === 0) return [];
  const t = tx.context.tenantId;
  const sets = money.map(
    (f) => sql`${sql.ref(`${ident(f)}_corporate`)} = CASE
      WHEN target.rate IS NULL OR x.${sql.ref(ident(f))} IS NULL THEN NULL
      ELSE round(x.${sql.ref(ident(f))} / target.rate, 2) END`,
  );
  const rows = await sql<{ id: string }>`
    WITH target AS (
      SELECT x.id, r.rate, r.effective_date FROM ${sql.table(ident(table))} x
      ${rateOn(t, code, sql`${date}::date`)}
      WHERE x.tenant_id = ${t}::uuid AND x.currency_code = ${code} AND x.id > ${after}::uuid
        AND x.corporate_rate_date = ${date}::date
      ORDER BY x.id LIMIT ${BATCH})
    UPDATE ${sql.table(ident(table))} x
       SET ${sql.join(sets)}, corporate_rate_date = target.effective_date
      FROM target
     WHERE x.tenant_id = ${t}::uuid AND x.id = target.id
    RETURNING x.id`.execute(tx.kysely);
  return rows.rows.map((r) => r.id).sort();
}
