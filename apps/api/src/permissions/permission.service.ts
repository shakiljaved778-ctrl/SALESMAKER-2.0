import { Inject, Injectable } from '@nestjs/common';
import type { TenantTransaction } from '@sm/db';
import {
  effectivePermissions,
  isSystemPermission,
  PermissionCache,
  type EffectivePermissions,
  type Grants,
  type PermissionSource,
} from '@sm/permissions';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { LOGGER, REDIS } from '../tokens.js';

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

/** Effective permissions per user (§6.2), cached in Valkey under the tenant's permVersion. */
@Injectable()
export class PermissionService {
  private readonly cache: PermissionCache;

  constructor(@Inject(REDIS) redis: Redis, @Inject(LOGGER) logger: Logger) {
    this.cache = new PermissionCache(redis, 3600, (err) => {
      logger.warn({ err }, 'permission cache unavailable; computing directly');
    });
  }

  async forUser(tx: TenantTransaction, userId: string): Promise<EffectivePermissions> {
    const { tenantId } = tx.context;
    // Read the version first: data read afterwards is never older than the key it is stored under.
    const { permVersion } = await tx.prisma.tenantSettings.findUniqueOrThrow({
      where: { tenantId },
      select: { permVersion: true },
    });
    return this.cache.getOrCompute(tenantId, userId, permVersion, async () =>
      effectivePermissions(await loadPermissionSource(tx, userId)),
    );
  }
}
