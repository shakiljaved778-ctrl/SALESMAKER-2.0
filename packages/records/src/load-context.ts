import { loadTenantMetadata, principalsOf, type TenantTransaction } from '@sm/db';
import { MetadataIndex, standardObject } from '@sm/metadata';
import {
  effectivePermissions,
  isSystemPermission,
  objectAccess,
  type EffectivePermissions,
  type Grants,
  type PermissionSource,
} from '@sm/permissions';
import type { ObjectSharing, SharingContext, SharingPrincipals } from '@sm/query-engine';
import { sql } from 'kysely';

import type { RecordContext } from './context.js';
import { tenantCurrencyConverter } from './currency.js';

/*
 * Building a RecordContext from the database: who the user is, what they may do and which
 * records they may reach. The API caches the permission and principal parts per permVersion;
 * background jobs load them directly, as the user who started the job.
 */

const GRANTS = {
  select: {
    deletedAt: true,
    systemPermissions: true,
    objectPermissions: true,
    fieldPermissions: true,
  },
} as const;

interface GrantRows {
  deletedAt?: Date | null;
  systemPermissions: { name: string }[];
  objectPermissions: {
    object: string;
    canRead: boolean;
    canCreate: boolean;
    canEdit: boolean;
    canDelete: boolean;
    viewAll: boolean;
    modifyAll: boolean;
  }[];
  fieldPermissions: { object: string; field: string; canRead: boolean; canEdit: boolean }[];
}

/** Database grant rows → the engine's Grants. */
export function toGrants(rows: GrantRows | null | undefined): Grants {
  const grants: Grants = { system: [], objects: {}, fields: {} };
  if (!rows || rows.deletedAt) return grants; // a deleted set grants nothing
  grants.system = rows.systemPermissions.map((r) => r.name).filter(isSystemPermission);
  for (const o of rows.objectPermissions)
    grants.objects[o.object] = {
      read: o.canRead,
      create: o.canCreate,
      edit: o.canEdit,
      delete: o.canDelete,
      viewAll: o.viewAll,
      modifyAll: o.modifyAll,
    };
  for (const f of rows.fieldPermissions)
    (grants.fields[f.object] ??= {})[f.field] = { read: f.canRead, edit: f.canEdit };
  return grants;
}

const EMPTY: PermissionSource = {
  profile: { system: [], objects: {}, fields: {} },
  sets: [],
  groups: [],
};

/**
 * Loads where a user's permissions come from (profile, assigned sets, assigned groups and their
 * muting sets) inside the caller's tenant transaction. A deactivated or not-yet-active user
 * holds nothing, whatever is assigned.
 */
export async function loadPermissionSource(
  tx: TenantTransaction,
  userId: string,
): Promise<PermissionSource> {
  const user = await tx.prisma.user.findUnique({
    where: { tenantId_id: { tenantId: tx.context.tenantId, id: userId } },
    select: {
      status: true,
      deactivatedAt: true,
      deletedAt: true,
      profile: { select: { deletedAt: true, permissionSet: GRANTS } },
      permissionAssignments: {
        select: {
          permissionSet: GRANTS,
          permissionSetGroup: {
            select: {
              deletedAt: true,
              mutingSet: GRANTS,
              members: { select: { permissionSet: GRANTS } },
            },
          },
        },
      },
    },
  });
  if (!user || user.status !== 'ACTIVE' || user.deactivatedAt || user.deletedAt) return EMPTY;
  const profile = user.profile && !user.profile.deletedAt ? user.profile.permissionSet : null;
  return {
    profile: toGrants(profile),
    sets: user.permissionAssignments.flatMap((a) =>
      a.permissionSet ? [toGrants(a.permissionSet)] : [],
    ),
    groups: user.permissionAssignments.flatMap((a) =>
      a.permissionSetGroup && !a.permissionSetGroup.deletedAt
        ? [
            {
              sets: a.permissionSetGroup.members.map((m) => toGrants(m.permissionSet)),
              muting: a.permissionSetGroup.mutingSet
                ? toGrants(a.permissionSetGroup.mutingSet)
                : undefined,
            },
          ]
        : [],
    ),
  };
}

/**
 * Sharing settings for the tenant's objects (§6.3): the org-wide default row, else the object's
 * catalogue default (custom objects: private), and the parents a CONTROLLED_BY_PARENT object delegates to.
 */
export async function loadObjectSharing(
  tx: TenantTransaction,
  metadata: MetadataIndex,
): Promise<Map<string, ObjectSharing>> {
  const rows = await tx.prisma.orgWideDefault.findMany({
    select: { object: true, sharingModel: true, grantHierarchy: true },
  });
  const owd = new Map(rows.map((r) => [r.object, r]));
  const settings = new Map<string, ObjectSharing>();
  for (const object of metadata.metadata.objects) {
    const row = owd.get(object.apiName);
    const catalogue = standardObject(object.apiName)?.sharing;
    const parents = (catalogue?.parentFields ?? []).flatMap((field) => {
      const target = object.fields.find((f) => f.apiName === field)?.referenceTo[0];
      return target ? [{ field, object: target }] : [];
    });
    settings.set(object.apiName, {
      object: object.apiName,
      table: object.table,
      sharingModel: row?.sharingModel ?? catalogue?.default ?? 'PRIVATE',
      grantHierarchy: row?.grantHierarchy ?? true,
      parents,
    });
  }
  return settings;
}

/** The sharing context over loaded settings, with View All / Modify All bypasses (§6.3). */
export function sharingContextOf(
  tenantId: string,
  principals: SharingPrincipals,
  permissions: EffectivePermissions,
  settings: ReadonlyMap<string, ObjectSharing>,
  visibleOwners?: readonly string[],
): SharingContext {
  return {
    tenantId,
    principals,
    ...(visibleOwners ? { visibleOwners } : {}),
    objectSharing: (name) => {
      const s = settings.get(name);
      if (!s) throw new Error(`no sharing settings for ${name}`);
      return s;
    },
    bypasses: (name, level) => {
      const access = objectAccess(permissions, name);
      return level === 'read' ? access.viewAll : access.modifyAll;
    },
  };
}

/** The user's visibility closure (§6.3 hierarchy and queues), as of this transaction. */
async function visibleOwnersOf(tx: TenantTransaction, userId: string): Promise<string[]> {
  const rows = await sql<{ owner_id: string }>`
    SELECT owner_id FROM user_visibility_closure
     WHERE tenant_id = ${tx.context.tenantId}::uuid AND viewer_user_id = ${userId}::uuid`.execute(
    tx.kysely,
  );
  return rows.rows.map((r) => r.owner_id);
}

const USER_GLOBALS = ['id', 'name', 'email', 'title', 'department', 'timezone', 'locale'] as const;

/**
 * Everything RecordService needs to write as `userId`, loaded in the caller's transaction. Pass
 * `permissions` and `principals` when the caller has them cached.
 */
export async function loadRecordContext(
  tx: TenantTransaction,
  userId: string,
  options: {
    permissions?: EffectivePermissions;
    principals?: SharingPrincipals;
    /** The tenant's metadata, when the caller has it cached at the current version. */
    metadata?: MetadataIndex;
    requestId?: string;
    now?: () => Date;
    /**
     * Read the user's visibility closure now and inline it in sharing predicates (better plans).
     * For contexts that live one request; long jobs keep the per-statement subquery, so a
     * hierarchy change mid-job applies at once.
     */
    inlineVisibility?: boolean;
  } = {},
): Promise<RecordContext> {
  const { tenantId } = tx.context;
  const settings = await tx.prisma.tenantSettings.findUniqueOrThrow({ where: { tenantId } });
  const user = await tx.prisma.user.findUnique({
    where: { tenantId_id: { tenantId, id: userId } },
    select: {
      id: true,
      name: true,
      email: true,
      title: true,
      department: true,
      timezone: true,
      locale: true,
    },
  });
  const metadata =
    options.metadata ?? new MetadataIndex(await loadTenantMetadata(tx, settings.metadataVersion));
  const permissions =
    options.permissions ?? effectivePermissions(await loadPermissionSource(tx, userId));
  const principals = options.principals ?? (await principalsOf(tx, userId));
  const userGlobals = new Map<string, unknown>(USER_GLOBALS.map((k) => [k, user ? user[k] : null]));
  const orgGlobals = new Map<string, unknown>([
    ['id', tenantId],
    ['name', settings.name],
    ['corporate_currency', settings.corporateCurrency],
  ]);
  return {
    userId,
    metadata,
    permissions,
    sharing: sharingContextOf(
      tenantId,
      principals,
      permissions,
      await loadObjectSharing(tx, metadata),
      options.inlineVisibility ? await visibleOwnersOf(tx, userId) : undefined,
    ),
    corporateCurrency: settings.corporateCurrency,
    timezone: user?.timezone ?? settings.defaultTimezone,
    currency: tenantCurrencyConverter(tx, settings.corporateCurrency),
    globals: (scope, name) => (scope === 'User' ? userGlobals : orgGlobals).get(name) ?? null,
    ...(options.now ? { now: options.now } : {}),
    ...(options.requestId ? { requestId: options.requestId } : {}),
  };
}
