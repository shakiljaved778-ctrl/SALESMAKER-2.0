import type { TenantTransaction } from '@sm/db';
import { sql, type RawBuilder } from 'kysely';

/**
 * Derived columns that triggers keep current on every write (duplicate-matching keys, migration
 * 0022). Rows written before a trigger existed get their values from this backfill: a migration
 * cannot see tenant rows under forced RLS. Bump DERIVED_VERSION with a new derived column, and add
 * its backfill below.
 */
export const DERIVED_VERSION = 1;
export const DERIVED_BACKFILL_TOPIC = 'maintenance.derived_backfill';

const BATCH = 1000;

const BACKFILL: Record<'lead' | 'contact' | 'account', RawBuilder<unknown>> = {
  lead: sql`match_email = crm_email_key(email), match_email_domain = crm_email_domain(email),
    match_phone = crm_phone_key(phone), match_mobile = crm_phone_key(mobile_phone),
    match_name_key = crm_name_key(last_name), match_company_key = crm_company_key(company)`,
  contact: sql`match_email = crm_email_key(email), match_email_domain = crm_email_domain(email),
    match_phone = crm_phone_key(phone), match_mobile = crm_phone_key(mobile_phone),
    match_name_key = crm_name_key(last_name)`,
  account: sql`match_company_key = crm_company_key(name), match_phone = crm_phone_key(phone),
    match_domain = crm_domain_key(website)`,
};

/**
 * Bring one tenant's derived columns up to DERIVED_VERSION, a batch per transaction (keyset by
 * id, so a restart resumes from scratch cheaply and never holds long locks). Derived values only:
 * no version bump, history or audit per record. Returns the rows rewritten (0 when current).
 */
export async function backfillDerivedColumns(
  inTenant: <T>(fn: (tx: TenantTransaction) => Promise<T>) => Promise<T>,
  options: { batch?: number } = {},
): Promise<number> {
  const current = await inTenant(async (tx) => {
    const settings = await tx.prisma.tenantSettings.findUnique({
      where: { tenantId: tx.context.tenantId },
      select: { derivedVersion: true },
    });
    return settings?.derivedVersion ?? DERIVED_VERSION;
  });
  if (current >= DERIVED_VERSION) return 0;
  const batch = options.batch ?? BATCH;
  let total = 0;
  for (const [table, assignments] of Object.entries(BACKFILL)) {
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const last = await inTenant(async (tx) => {
        const rows = await sql<{ id: string }>`
          UPDATE ${sql.table(table)} AS r SET ${assignments}
           WHERE r.tenant_id = ${tx.context.tenantId}::uuid AND r.id IN (
             SELECT id FROM ${sql.table(table)}
              WHERE tenant_id = ${tx.context.tenantId}::uuid AND id > ${after}::uuid
              ORDER BY id LIMIT ${batch})
          RETURNING r.id`.execute(tx.kysely);
        return rows.rows.map((r) => r.id).sort();
      });
      total += last.length;
      if (last.length < batch) break;
      after = last[last.length - 1] ?? after;
    }
  }
  await inTenant((tx) =>
    tx.prisma.tenantSettings.update({
      where: { tenantId: tx.context.tenantId },
      data: { derivedVersion: DERIVED_VERSION },
    }),
  );
  return total;
}
