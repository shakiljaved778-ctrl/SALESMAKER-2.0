import { Inject, Injectable } from '@nestjs/common';
import type { TenantTransaction } from '@sm/db';
import { standardObject } from '@sm/metadata';
import {
  fieldAccess,
  hasSystemPermission,
  objectAccess,
  type EffectivePermissions,
  type ObjectAccess,
  type SystemPermissionName,
} from '@sm/permissions';
import {
  sharingPredicate,
  type AccessLevel,
  type ObjectSharing,
  type SharingContext,
} from '@sm/query-engine';
import { errors } from '@sm/server-kit';
import { sql } from 'kysely';

import { PermissionService } from '../permissions/permission.service.js';
import { SharingService } from '../sharing/sharing.service.js';
import { RECORD_TABLES } from '../tokens.js';
import type { RecordTables } from './record-tables.js';

export type RecordAccess = 'none' | AccessLevel;
export type RecordAction = 'read' | 'create' | 'edit' | 'delete' | 'transfer' | 'share';

/** The §6.2 layer that refused an action, when one did. */
export type DeniedLayer = 'object' | 'record' | 'field';

export interface AccessDecision {
  allowed: boolean;
  deniedBy?: DeniedLayer;
  /** Fields the caller may not read (read) or edit (create, edit). */
  deniedFields?: string[];
}

const LEVELS: readonly AccessLevel[] = ['read', 'edit', 'full'];

/** Object permission and record access each action needs (§6.2, Salesforce semantics). */
const NEEDS: Record<RecordAction, { object: keyof ObjectAccess; record: AccessLevel | null }> = {
  read: { object: 'read', record: 'read' },
  create: { object: 'create', record: null },
  edit: { object: 'edit', record: 'edit' },
  delete: { object: 'delete', record: 'full' },
  transfer: { object: 'edit', record: 'full' },
  share: { object: 'read', record: 'full' },
};

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export interface AccessReasonDto {
  kind:
    | 'SYSTEM_PERMISSION'
    | 'OBJECT_PERMISSION'
    | 'ORG_WIDE_DEFAULT'
    | 'OWNER'
    | 'HIERARCHY'
    | 'QUEUE'
    | 'SHARE'
    | 'PARENT';
  level: RecordAccess;
  permission?: string;
  sharingModel?: string;
  ownerId?: string;
  shareReason?: 'RULE' | 'MANUAL' | 'TEAM' | 'TERRITORY' | 'IMPLICIT_PARENT' | 'IMPLICIT_CHILD';
  principalType?: 'USER' | 'GROUP' | 'QUEUE' | 'ORG_UNIT' | 'ORG_UNIT_AND_SUBORDINATES';
  principalId?: string;
  parentObject?: string;
  parentId?: string;
}

const LEVEL_OF: Record<number, RecordAccess> = { 1: 'read', 2: 'edit', 3: 'full' };

/**
 * The ordered authorisation check (§6.2): tenant (RLS, by construction) → system permissions →
 * object permissions → record access (sharing, §6.3–6.4) → field-level security. Every layer must
 * pass. Controllers and RecordService (P02) call this; nothing else decides access.
 */
@Injectable()
export class AccessService {
  constructor(
    private readonly permissions: PermissionService,
    private readonly sharing: SharingService,
    @Inject(RECORD_TABLES) private readonly tables: RecordTables,
  ) {}

  permissionsOf(tx: TenantTransaction, userId: string): Promise<EffectivePermissions> {
    return this.permissions.forUser(tx, userId);
  }

  /** Layer 2: throws 403 unless the user holds the system permission. */
  async requireSystemPermission(
    tx: TenantTransaction,
    userId: string,
    name: SystemPermissionName,
  ): Promise<void> {
    if (!hasSystemPermission(await this.permissionsOf(tx, userId), name)) throw errors.forbidden();
  }

  /**
   * The sharing context for `object` and the parents it may delegate to (§6.4): org-wide
   * defaults, tables, principals and the View All / Modify All bypasses.
   */
  async sharingContext(
    tx: TenantTransaction,
    userId: string,
    permissions: EffectivePermissions,
    object: string,
  ): Promise<SharingContext> {
    const settings = new Map<string, ObjectSharing>();
    const load = async (name: string, depth: number): Promise<void> => {
      if (settings.has(name) || depth > 3) return;
      const owd = await this.sharing.orgWideDefault(tx, name);
      const parents = (standardObject(name)?.sharing.parentFields ?? []).flatMap((field) => {
        const target = standardObject(name)?.fields.find((f) => f.apiName === field)?.references;
        return target?.[0] ? [{ field, object: target[0] }] : [];
      });
      settings.set(name, {
        object: name,
        table: this.tables(name),
        sharingModel: owd.sharingModel,
        grantHierarchy: owd.grantHierarchy,
        parents,
      });
      for (const p of parents) await load(p.object, depth + 1);
    };
    await load(object, 0);
    const principals = await this.sharing.principals(tx, userId);
    return {
      tenantId: tx.context.tenantId,
      principals,
      objectSharing: (name) => {
        const s = settings.get(name);
        if (!s) throw new Error(`no sharing settings loaded for ${name}`);
        return s;
      },
      bypasses: (name, level) => {
        const access = objectAccess(permissions, name);
        return level === 'read' ? access.viewAll : access.modifyAll;
      },
    };
  }

  private async tableExists(tx: TenantTransaction, table: string): Promise<boolean> {
    if (!IDENT.test(table)) return false;
    const rows = await tx.prisma.$queryRaw<{ ok: boolean }[]>`
      SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS ok`;
    return rows[0]?.ok === true;
  }

  /** Layer 4: the highest record access the user has, or 'none' (also for a missing record). */
  async recordAccess(
    tx: TenantTransaction,
    userId: string,
    object: string,
    recordId: string,
    permissions?: EffectivePermissions,
  ): Promise<RecordAccess> {
    const table = this.tables(object);
    if (!(await this.tableExists(tx, table))) return 'none';
    const eff = permissions ?? (await this.permissionsOf(tx, userId));
    const ctx = await this.sharingContext(tx, userId, eff, object);
    const row = await tx.kysely
      .selectFrom(`${table} as r`)
      .select([
        sql<boolean>`${sharingPredicate(ctx, object, 'r', 'read')}`.as('read'),
        sql<boolean>`${sharingPredicate(ctx, object, 'r', 'edit')}`.as('edit'),
        sql<boolean>`${sharingPredicate(ctx, object, 'r', 'full')}`.as('full'),
      ])
      .where(sql.ref('r.id'), '=', recordId)
      .executeTakeFirst();
    if (!row) return 'none';
    return [...LEVELS].reverse().find((l) => row[l]) ?? 'none';
  }

  /**
   * Can the user perform `action` on `object` (and on `recordId`, and on these `fields`)? Checks
   * the §6.2 layers in order and reports the first that refuses.
   */
  async check(
    tx: TenantTransaction,
    userId: string,
    request: {
      object: string;
      action: RecordAction;
      recordId?: string;
      fields?: readonly string[];
    },
  ): Promise<AccessDecision> {
    const eff = await this.permissionsOf(tx, userId);
    const needs = NEEDS[request.action];
    if (!objectAccess(eff, request.object)[needs.object])
      return { allowed: false, deniedBy: 'object' };
    if (needs.record && request.recordId) {
      const have = await this.recordAccess(tx, userId, request.object, request.recordId, eff);
      if (have === 'none' || LEVELS.indexOf(have) < LEVELS.indexOf(needs.record))
        return { allowed: false, deniedBy: 'record' };
    }
    if (request.fields?.length) {
      const writing = request.action === 'create' || request.action === 'edit';
      const denied = request.fields.filter((field) => {
        const access = fieldAccess(eff, request.object, field);
        return writing ? !access.edit : !access.read;
      });
      if (denied.length) return { allowed: false, deniedBy: 'field', deniedFields: denied };
    }
    return { allowed: true };
  }

  /** Throws 404 (not visible) or 403 (visible, but not allowed) unless the check passes. */
  async assert(
    tx: TenantTransaction,
    userId: string,
    request: Parameters<AccessService['check']>[2],
  ): Promise<void> {
    const decision = await this.check(tx, userId, request);
    if (decision.allowed) return;
    if (
      decision.deniedBy === 'record' &&
      request.recordId &&
      (await this.recordAccess(tx, userId, request.object, request.recordId)) === 'none'
    )
      throw errors.notFound('Record');
    throw errors.forbidden();
  }

  /**
   * "Why can I see this?" (§6.3): every reason the user can access the record, or null when they
   * cannot see it at all (so the caller answers 404 and existence does not leak).
   */
  async describe(
    tx: TenantTransaction,
    userId: string,
    object: string,
    recordId: string,
    depth = 0,
  ): Promise<{
    access: RecordAccess;
    objectPermissions: ObjectAccess;
    reasons: AccessReasonDto[];
  } | null> {
    const eff = await this.permissionsOf(tx, userId);
    const objectPermissions = objectAccess(eff, object);
    const access = objectPermissions.read
      ? await this.recordAccess(tx, userId, object, recordId, eff)
      : 'none';
    if (access === 'none') return null;
    const reasons: AccessReasonDto[] = [];
    for (const [permission, level] of [
      ['modify_all_data', 'full'],
      ['view_all_data', 'read'],
    ] as const)
      if (eff.system.has(permission))
        reasons.push({ kind: 'SYSTEM_PERMISSION', level, permission });
    const own = eff.objects[object];
    if (own?.modifyAll)
      reasons.push({ kind: 'OBJECT_PERMISSION', level: 'full', permission: 'modify_all' });
    else if (own?.viewAll)
      reasons.push({ kind: 'OBJECT_PERMISSION', level: 'read', permission: 'view_all' });

    const ctx = await this.sharingContext(tx, userId, eff, object);
    const settings = ctx.objectSharing(object);
    if (settings.sharingModel === 'PUBLIC_READ' || settings.sharingModel === 'PUBLIC_READ_WRITE')
      reasons.push({
        kind: 'ORG_WIDE_DEFAULT',
        level: settings.sharingModel === 'PUBLIC_READ' ? 'read' : 'edit',
        sharingModel: settings.sharingModel,
      });

    const record = await tx.kysely
      .selectFrom(`${settings.table} as r`)
      .selectAll()
      .where(sql.ref('r.id'), '=', recordId)
      .executeTakeFirst();
    const ownerId = typeof record?.['owner_id'] === 'string' ? record['owner_id'] : null;
    const { principals } = ctx;
    if (ownerId === userId) reasons.push({ kind: 'OWNER', level: 'full' });
    else if (ownerId && principals.queueIds.includes(ownerId))
      reasons.push({ kind: 'QUEUE', level: 'full', ownerId });
    else if (ownerId && settings.grantHierarchy) {
      const seen = await tx.prisma.userVisibilityClosure.count({
        where: { viewerUserId: userId, ownerId },
      });
      if (seen) reasons.push({ kind: 'HIERARCHY', level: 'full', ownerId });
    }

    const exact = [
      principals.userId,
      ...principals.groupIds,
      ...principals.queueIds,
      ...(principals.orgUnitId ? [principals.orgUnitId] : []),
    ];
    const shares = await tx.prisma.recordShare.findMany({
      where: {
        object,
        recordId,
        OR: [
          { principalType: { not: 'ORG_UNIT_AND_SUBORDINATES' }, principalId: { in: exact } },
          {
            principalType: 'ORG_UNIT_AND_SUBORDINATES',
            principalId: { in: [...principals.orgUnitAndAncestors] },
          },
        ],
      },
      orderBy: [{ access: 'desc' }, { createdAt: 'asc' }],
    });
    for (const s of shares)
      reasons.push({
        kind: 'SHARE',
        level: LEVEL_OF[s.access] ?? 'read',
        shareReason: s.reason,
        principalType: s.principalType,
        principalId: s.principalId,
      });

    if (settings.sharingModel === 'CONTROLLED_BY_PARENT' && depth < 3)
      for (const parent of settings.parents ?? []) {
        const parentId = record?.[parent.field];
        if (typeof parentId !== 'string') continue;
        const parentAccess = await this.recordAccess(tx, userId, parent.object, parentId, eff);
        if (parentAccess !== 'none')
          reasons.push({
            kind: 'PARENT',
            level: parentAccess,
            parentObject: parent.object,
            parentId,
          });
      }
    return { access, objectPermissions, reasons };
  }
}
