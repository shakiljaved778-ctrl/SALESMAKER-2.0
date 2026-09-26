import { sql, type Expression, type SqlBool } from 'kysely';

/** Record access levels (§6.3): Read, Read-Write, Full (owner-equivalent: transfer, share, delete). */
export type AccessLevel = 'read' | 'edit' | 'full';
export const ACCESS_LEVEL: Readonly<Record<AccessLevel, 1 | 2 | 3>> = { read: 1, edit: 2, full: 3 };

export type SharingModel = 'PRIVATE' | 'PUBLIC_READ' | 'PUBLIC_READ_WRITE' | 'CONTROLLED_BY_PARENT';

/** Structurally the same as @sm/db `Principals`. */
export interface SharingPrincipals {
  userId: string;
  groupIds: readonly string[];
  queueIds: readonly string[];
  orgUnitId: string | null;
  orgUnitAndAncestors: readonly string[];
}

export interface ObjectSharing {
  object: string;
  /** The physical table holding the object's records (with id, tenant_id and owner_id). */
  table: string;
  sharingModel: SharingModel;
  grantHierarchy: boolean;
  /** CONTROLLED_BY_PARENT: lookup fields whose parent record decides access. */
  parents?: readonly { field: string; object: string }[];
}

export interface SharingContext {
  tenantId: string;
  principals: SharingPrincipals;
  /** Sharing settings of an object (OWD + table), resolved by the caller. */
  objectSharing(object: string): ObjectSharing;
  /**
   * Whether object or data-wide permissions bypass sharing at this level (§6.3): View All or
   * view_all_data for read; Modify All or modify_all_data for anything.
   */
  bypasses(object: string, level: AccessLevel): boolean;
}

/** Parents of parents are followed this deep (quote → opportunity → account). */
export const MAX_PARENT_DEPTH = 3;

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`invalid identifier ${name}`);
  return name;
}

const uuids = (ids: readonly string[]) => sql`${sql.val([...ids])}::uuid[]`;

/** Owner, hierarchy and queue access (§6.3, §6.4). The owner always sees their own records. */
function ownerAccess(ctx: SharingContext, s: ObjectSharing, alias: string): Expression<SqlBool> {
  const owner = sql.ref(`${alias}.owner_id`);
  const { userId, queueIds } = ctx.principals;
  if (!s.grantHierarchy)
    return sql<SqlBool>`(${owner} = ${userId}::uuid OR ${owner} = ANY (${uuids(queueIds)}))`;
  return sql<SqlBool>`(${owner} = ${userId}::uuid OR ${owner} IN (
    SELECT v.owner_id FROM user_visibility_closure v
    WHERE v.tenant_id = ${ctx.tenantId}::uuid AND v.viewer_user_id = ${userId}::uuid))`;
}

/** An explicit share (rule, manual, team, territory, implicit) at the needed level (§6.4). */
function shareAccess(
  ctx: SharingContext,
  object: string,
  alias: string,
  level: AccessLevel,
): Expression<SqlBool> {
  const p = ctx.principals;
  const exact = [p.userId, ...p.groupIds, ...p.queueIds, ...(p.orgUnitId ? [p.orgUnitId] : [])];
  return sql<SqlBool>`EXISTS (
    SELECT 1 FROM record_share s
    WHERE s.tenant_id = ${ctx.tenantId}::uuid AND s.object = ${object}
      AND s.record_id = ${sql.ref(`${alias}.id`)} AND s.access >= ${ACCESS_LEVEL[level]}
      AND ((s.principal_type <> 'ORG_UNIT_AND_SUBORDINATES' AND s.principal_id = ANY (${uuids(exact)}))
        OR (s.principal_type = 'ORG_UNIT_AND_SUBORDINATES'
          AND s.principal_id = ANY (${uuids(p.orgUnitAndAncestors)}))))`;
}

const TRUE = sql<SqlBool>`TRUE`;
const FALSE = sql<SqlBool>`FALSE`;

/**
 * The record-access predicate the Query Engine injects for `object` rows aliased `alias` (§6.4):
 * true exactly for the rows the context's user may access at `level`. It is a plain SQL
 * expression (EXISTS / IN subqueries against the closure and the share table), so it composes
 * with any other where-clause and uses the (tenant_id, …) indexes.
 */
export function sharingPredicate(
  ctx: SharingContext,
  object: string,
  alias: string,
  level: AccessLevel,
  depth = 0,
): Expression<SqlBool> {
  ident(alias);
  if (ctx.bypasses(object, level)) return TRUE;
  const s = ctx.objectSharing(object);
  if (s.sharingModel === 'PUBLIC_READ_WRITE' && level !== 'full') return TRUE;
  if (s.sharingModel === 'PUBLIC_READ' && level === 'read') return TRUE;

  const parents = s.sharingModel === 'CONTROLLED_BY_PARENT' ? (s.parents ?? []) : [];
  if (parents.length === 0) {
    // A CONTROLLED_BY_PARENT object without parent fields cannot delegate: owner + shares.
    return sql<SqlBool>`(${ownerAccess(ctx, s, alias)} OR ${shareAccess(ctx, object, alias, level)})`;
  }
  if (depth >= MAX_PARENT_DEPTH) return FALSE;

  // Access to the child is access to any of its parents at the same level; a child with no parent
  // at all (e.g. a contact without an account, §6.3 v1.3) falls back to owner + hierarchy.
  const viaParents = parents.map(({ field, object: parentObject }) => {
    const parent = ctx.objectSharing(parentObject);
    const p = `p${String(depth + 1)}_${ident(field)}`;
    return sql<SqlBool>`(${sql.ref(`${alias}.${ident(field)}`)} IS NOT NULL AND EXISTS (
      SELECT 1 FROM ${sql.table(ident(parent.table))} AS ${sql.raw(p)}
      WHERE ${sql.ref(`${p}.id`)} = ${sql.ref(`${alias}.${field}`)}
        AND ${sharingPredicate(ctx, parentObject, p, level, depth + 1)}))`;
  });
  const orphan = sql<SqlBool>`(${sql.join(
    parents.map(({ field }) => sql`${sql.ref(`${alias}.${field}`)} IS NULL`),
    sql` AND `,
  )} AND (${ownerAccess(ctx, s, alias)} OR ${shareAccess(ctx, object, alias, level)}))`;
  return sql<SqlBool>`(${sql.join([...viaParents, orphan], sql` OR `)})`;
}
