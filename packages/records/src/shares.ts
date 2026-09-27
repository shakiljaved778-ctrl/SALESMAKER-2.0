import type { TenantTransaction } from '@sm/db';
import { sql } from 'kysely';

/*
 * Shares the platform derives from CRM data (§6.3): team membership (TEAM) and implicit sharing
 * between accounts and their children (IMPLICIT_PARENT, IMPLICIT_CHILD). They are recomputed
 * set-wise from the source rows whenever those change, so they can never drift: delete what
 * this module owns for the records, insert what the sources say now. Rule, manual and territory
 * shares are never touched here.
 *
 * - An account team member gets the membership's access on the account, and its
 *   `opportunity_access` (0 none, 1 read, 2 edit) on the account's opportunities.
 * - An opportunity team member gets the membership's access on the opportunity.
 * - Owners of an account's live contacts and opportunities get Read on the account
 *   (IMPLICIT_PARENT), so they can see what their records hang off.
 * - The account owner gets Read on the account's opportunities (IMPLICIT_CHILD). Contacts need
 *   nothing: under CONTROLLED_BY_PARENT they follow the account already.
 */

const uuids = (ids: readonly string[]) => sql`${sql.val([...new Set(ids)])}::uuid[]`;

/** The share principal type of the owner in row `x`: owners are users or queues. */
const OWNER_TYPE = sql`(CASE WHEN EXISTS (
    SELECT 1 FROM queue q WHERE q.tenant_id = x.tenant_id AND q.id = x.owner_id
  ) THEN 'QUEUE' ELSE 'USER' END)::share_principal_type`;

/** Recompute TEAM and IMPLICIT_CHILD shares on these opportunities. */
export async function syncOpportunityShares(
  tx: TenantTransaction,
  opportunityIds: readonly string[],
): Promise<void> {
  if (opportunityIds.length === 0) return;
  const tenantId = tx.context.tenantId;
  const ids = uuids(opportunityIds);
  await sql`DELETE FROM record_share
    WHERE tenant_id = ${tenantId}::uuid AND object = 'opportunity' AND record_id = ANY (${ids})
      AND reason IN ('TEAM', 'IMPLICIT_CHILD')`.execute(tx.kysely);
  await sql`
    INSERT INTO record_share (tenant_id, object, record_id, principal_type, principal_id, access, reason, source_id)
    SELECT x.tenant_id, 'opportunity', x.opportunity_id, 'USER'::share_principal_type, x.user_id, x.access, 'TEAM'::share_reason, x.id
      FROM opportunity_team_member x JOIN opportunity o
        ON o.tenant_id = x.tenant_id AND o.id = x.opportunity_id AND o.deleted_at IS NULL
     WHERE x.tenant_id = ${tenantId}::uuid AND x.opportunity_id = ANY (${ids})
    UNION ALL
    SELECT x.tenant_id, 'opportunity', o.id, 'USER'::share_principal_type, x.user_id, x.opportunity_access, 'TEAM'::share_reason, x.id
      FROM opportunity o JOIN account_team_member x
        ON x.tenant_id = o.tenant_id AND x.account_id = o.account_id
     WHERE o.tenant_id = ${tenantId}::uuid AND o.id = ANY (${ids}) AND o.deleted_at IS NULL
       AND x.opportunity_access > 0
    UNION ALL
    SELECT x.tenant_id, 'opportunity', o.id, ${OWNER_TYPE}, x.owner_id, 1,
           'IMPLICIT_CHILD'::share_reason, x.id
      FROM opportunity o JOIN account x
        ON x.tenant_id = o.tenant_id AND x.id = o.account_id AND x.deleted_at IS NULL
     WHERE o.tenant_id = ${tenantId}::uuid AND o.id = ANY (${ids}) AND o.deleted_at IS NULL
       AND x.owner_id IS DISTINCT FROM o.owner_id
    ON CONFLICT DO NOTHING`.execute(tx.kysely);
}

/**
 * Recompute TEAM and IMPLICIT_PARENT shares on these accounts; with `children`, also the
 * shares every opportunity of theirs derives from them (after an owner or team change).
 */
export async function syncAccountShares(
  tx: TenantTransaction,
  accountIds: readonly (string | null | undefined)[],
  options: { children?: boolean } = {},
): Promise<void> {
  const present = accountIds.filter((id): id is string => typeof id === 'string');
  if (present.length === 0) return;
  const tenantId = tx.context.tenantId;
  const ids = uuids(present);
  await sql`DELETE FROM record_share
    WHERE tenant_id = ${tenantId}::uuid AND object = 'account' AND record_id = ANY (${ids})
      AND reason IN ('TEAM', 'IMPLICIT_PARENT')`.execute(tx.kysely);
  await sql`
    INSERT INTO record_share (tenant_id, object, record_id, principal_type, principal_id, access, reason, source_id)
    SELECT x.tenant_id, 'account', x.account_id, 'USER'::share_principal_type, x.user_id, x.access, 'TEAM'::share_reason, x.id
      FROM account_team_member x JOIN account a
        ON a.tenant_id = x.tenant_id AND a.id = x.account_id AND a.deleted_at IS NULL
     WHERE x.tenant_id = ${tenantId}::uuid AND x.account_id = ANY (${ids})
    UNION
    SELECT a.tenant_id, 'account', a.id, ${OWNER_TYPE}, x.owner_id, 1,
           'IMPLICIT_PARENT'::share_reason, '00000000-0000-0000-0000-000000000000'::uuid
      FROM account a JOIN (
        SELECT tenant_id, account_id, owner_id FROM contact
         WHERE tenant_id = ${tenantId}::uuid AND account_id = ANY (${ids}) AND deleted_at IS NULL
        UNION
        SELECT tenant_id, account_id, owner_id FROM opportunity
         WHERE tenant_id = ${tenantId}::uuid AND account_id = ANY (${ids}) AND deleted_at IS NULL
      ) x ON x.tenant_id = a.tenant_id AND x.account_id = a.id
     WHERE a.tenant_id = ${tenantId}::uuid AND a.deleted_at IS NULL
       AND x.owner_id IS DISTINCT FROM a.owner_id
    ON CONFLICT DO NOTHING`.execute(tx.kysely);
  if (!options.children) return;
  const children = await sql<{ id: string }>`
    SELECT id FROM opportunity
     WHERE tenant_id = ${tenantId}::uuid AND account_id = ANY (${ids}) AND deleted_at IS NULL`.execute(
    tx.kysely,
  );
  const childIds = children.rows.map((r) => r.id);
  for (let i = 0; i < childIds.length; i += 1000)
    await syncOpportunityShares(tx, childIds.slice(i, i + 1000));
}

/**
 * What a write to `object` changes in derived shares, given the owner and account before and
 * after (null before on create, null after on delete).
 */
export async function syncAfterWrite(
  tx: TenantTransaction,
  object: string,
  id: string,
  before: { owner?: unknown; account?: unknown } | null,
  after: { owner?: unknown; account?: unknown } | null,
): Promise<void> {
  const changed = (k: 'owner' | 'account') => (before?.[k] ?? null) !== (after?.[k] ?? null);
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  if (object === 'account') {
    // A new, deleted or restored account, or a new owner: its shares and its opportunities'.
    if (!before || !after || changed('owner'))
      await syncAccountShares(tx, [id], { children: true });
    return;
  }
  if (object !== 'contact' && object !== 'opportunity') return;
  if (before && after && !changed('owner') && !changed('account')) return;
  if (object === 'opportunity') await syncOpportunityShares(tx, [id]);
  await syncAccountShares(tx, [str(before?.account), str(after?.account)]);
}
