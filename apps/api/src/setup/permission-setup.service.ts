import { Injectable } from '@nestjs/common';
import type {
  CreatePermissionSetGroupRequest,
  CreatePermissionSetRequest,
  CreateProfileRequest,
  GrantsDto,
  PermissionSetDetail,
  PermissionSetGroupDetail,
  PermissionSetSummary,
  ProfileDetail,
  ProfileSummary,
  UpdateNamedRequest,
  UpdatePermissionSetGroupRequest,
} from '@sm/contracts';
import { audit, type TenantTransaction } from '@sm/db';
import { flsFields, isStandardObject } from '@sm/metadata';
import { isSystemPermission, normaliseObjectAccess, type Grants } from '@sm/permissions';
import { errors } from '@sm/server-kit';
import type { z } from 'zod';

import { writeGrants } from '../permissions/default-profiles.js';
import { toGrants } from '../permissions/permission.service.js';
import { assertVersion, nameTaken } from './common.js';

type GrantsInput = z.infer<typeof GrantsDto>;
type FieldError = Parameters<typeof errors.validation>[0][number];

const GRANT_ROWS = {
  systemPermissions: { select: { name: true } },
  objectPermissions: true,
  fieldPermissions: true,
} as const;

/** The built-in administrator profile keeps its grants, so a workspace cannot lock itself out. */
const LOCKED_PROFILE = 'system_administrator';

/**
 * Check a grant bundle against the catalogue (§6.2): known system permissions, standard objects,
 * and only fields field-level security can restrict. Granting sets are closed under the access
 * dependencies (edit needs read, …); muting sets keep exactly the flags they name.
 */
export function validateGrants(input: GrantsInput, kind: 'grant' | 'muting'): Grants {
  const problems: FieldError[] = [];
  const system = [...new Set(input.system)];
  for (const name of system)
    if (!isSystemPermission(name))
      problems.push({
        field: 'grants.system',
        code: 'not_found',
        message: `Unknown permission ${name}`,
      });
  const grants: Grants = { system: system.filter(isSystemPermission), objects: {}, fields: {} };
  for (const [object, access] of Object.entries(input.objects)) {
    if (!isStandardObject(object)) {
      problems.push({
        field: `grants.objects.${object}`,
        code: 'not_found',
        message: 'Unknown object',
      });
      continue;
    }
    grants.objects[object] = kind === 'grant' ? normaliseObjectAccess(access) : { ...access };
  }
  for (const [object, byField] of Object.entries(input.fields)) {
    const allowed = new Set(flsFields(object).map((f) => f.apiName));
    const target: Record<string, { read: boolean; edit: boolean }> = {};
    for (const [field, access] of Object.entries(byField)) {
      if (!allowed.has(field)) {
        problems.push({
          field: `grants.fields.${object}.${field}`,
          code: 'not_found',
          message: 'Field-level security does not apply to this field',
        });
        continue;
      }
      target[field] =
        kind === 'grant' ? { read: access.read || access.edit, edit: access.edit } : { ...access };
    }
    grants.fields[object] = target;
  }
  if (problems.length) throw errors.validation(problems);
  return grants;
}

/** Replace every grant row of a permission set. */
async function replaceGrants(tx: TenantTransaction, permissionSetId: string, grants: Grants) {
  const where = { permissionSetId };
  await tx.prisma.systemPermission.deleteMany({ where });
  await tx.prisma.objectPermission.deleteMany({ where });
  await tx.prisma.fieldPermission.deleteMany({ where });
  await writeGrants(tx, tx.context.tenantId, permissionSetId, grants);
}

/** A JSON-safe copy for the Setup audit trail. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, never>;

/**
 * Profiles, permission sets and permission set groups (§6.2). Every write bumps the tenant's
 * permVersion through the database triggers, so cached effective permissions refresh on the
 * next request; every change writes the Setup audit trail with its before and after state.
 */
@Injectable()
export class PermissionSetupService {
  // ── Profiles ───────────────────────────────────────────────────────────────────────────────
  async listProfiles(tx: TenantTransaction): Promise<{ items: z.infer<typeof ProfileSummary>[] }> {
    const rows = await tx.prisma.profile.findMany({
      where: { deletedAt: null },
      include: { _count: { select: { users: true } } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return {
      items: rows.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        systemKey: p.systemKey,
        users: p._count.users,
        version: p.version,
      })),
    };
  }

  async getProfile(tx: TenantTransaction, id: string): Promise<z.infer<typeof ProfileDetail>> {
    const p = await tx.prisma.profile.findFirst({
      where: { id, deletedAt: null },
      include: { _count: { select: { users: true } }, permissionSet: { select: GRANT_ROWS } },
    });
    if (!p) throw errors.notFound('Profile');
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      systemKey: p.systemKey,
      users: p._count.users,
      version: p.version,
      grants: toGrants(p.permissionSet) as z.infer<typeof GrantsDto>,
    };
  }

  private async assertProfileName(tx: TenantTransaction, name: string, except?: string) {
    if (
      await tx.prisma.profile.findFirst({
        where: { name, ...(except ? { NOT: { id: except } } : {}) },
      })
    )
      throw nameTaken();
  }

  /** A new profile starts empty, or as a copy of another profile's grants. */
  async createProfile(
    tx: TenantTransaction,
    input: z.infer<typeof CreateProfileRequest>,
  ): Promise<z.infer<typeof ProfileDetail>> {
    await this.assertProfileName(tx, input.name);
    let grants: Grants = { system: [], objects: {}, fields: {} };
    if (input.cloneFrom) {
      const source = await tx.prisma.profile.findFirst({
        where: { id: input.cloneFrom, deletedAt: null },
        include: { permissionSet: { select: GRANT_ROWS } },
      });
      if (!source)
        throw errors.validation([
          { field: 'cloneFrom', code: 'not_found', message: 'No such profile' },
        ]);
      grants = toGrants(source.permissionSet);
    }
    const { tenantId } = tx.context;
    const actor = tx.context.userId ?? null;
    const set = await tx.prisma.permissionSet.create({
      data: { tenantId, kind: 'PROFILE', name: input.name, createdBy: actor, updatedBy: actor },
    });
    await writeGrants(tx, tenantId, set.id, grants);
    const profile = await tx.prisma.profile.create({
      data: {
        tenantId,
        name: input.name,
        description: input.description ?? null,
        permissionSetId: set.id,
        createdBy: actor,
        updatedBy: actor,
      },
    });
    await audit.setup(tx, {
      action: 'profile.created',
      entityType: 'profile',
      entityId: profile.id,
      entityName: profile.name,
      after: { name: profile.name, cloneFrom: input.cloneFrom ?? null, grants: plain(grants) },
    });
    return this.getProfile(tx, profile.id);
  }

  async updateProfile(
    tx: TenantTransaction,
    id: string,
    input: z.infer<typeof UpdateNamedRequest>,
  ): Promise<z.infer<typeof ProfileDetail>> {
    const before = await tx.prisma.profile.findFirst({ where: { id, deletedAt: null } });
    assertVersion(before, input.version, 'Profile');
    if (input.name) await this.assertProfileName(tx, input.name, id);
    const updated = await tx.prisma.profile.updateMany({
      where: { id, version: input.version },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        version: { increment: 1 },
        updatedBy: tx.context.userId ?? null,
      },
    });
    if (updated.count !== 1) assertVersion(null, input.version, 'Profile');
    if (input.name)
      await tx.prisma.permissionSet.update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id: before.permissionSetId } },
        data: { name: input.name },
      });
    await audit.setup(tx, {
      action: 'profile.updated',
      entityType: 'profile',
      entityId: id,
      entityName: before.name,
      before: { name: before.name, description: before.description },
      after: {
        name: input.name ?? before.name,
        description: input.description ?? before.description,
      },
    });
    return this.getProfile(tx, id);
  }

  async putProfileGrants(
    tx: TenantTransaction,
    id: string,
    input: { version: number; grants: GrantsInput },
  ): Promise<z.infer<typeof ProfileDetail>> {
    const profile = await tx.prisma.profile.findFirst({
      where: { id, deletedAt: null },
      include: { permissionSet: { select: GRANT_ROWS } },
    });
    assertVersion(profile, input.version, 'Profile');
    if (profile.systemKey === LOCKED_PROFILE)
      throw errors.conflict('The System Administrator profile’s permissions cannot change');
    const grants = validateGrants(input.grants, 'grant');
    const updated = await tx.prisma.profile.updateMany({
      where: { id, version: input.version },
      data: { version: { increment: 1 }, updatedBy: tx.context.userId ?? null },
    });
    if (updated.count !== 1) assertVersion(null, input.version, 'Profile');
    await replaceGrants(tx, profile.permissionSetId, grants);
    await audit.setup(tx, {
      action: 'profile.grants_changed',
      entityType: 'profile',
      entityId: id,
      entityName: profile.name,
      before: plain(toGrants(profile.permissionSet)),
      after: plain(grants),
    });
    return this.getProfile(tx, id);
  }

  async removeProfile(tx: TenantTransaction, id: string): Promise<void> {
    const profile = await tx.prisma.profile.findFirst({
      where: { id, deletedAt: null },
      include: { _count: { select: { users: true } } },
    });
    if (!profile) throw errors.notFound('Profile');
    if (profile.systemKey) throw errors.conflict('Built-in profiles cannot be deleted');
    if (profile._count.users) throw errors.conflict('Give this profile’s users another one first');
    const { tenantId } = tx.context;
    await tx.prisma.profile.delete({ where: { tenantId_id: { tenantId, id } } });
    await tx.prisma.permissionSet.delete({
      where: { tenantId_id: { tenantId, id: profile.permissionSetId } },
    });
    await audit.setup(tx, {
      action: 'profile.deleted',
      entityType: 'profile',
      entityId: id,
      entityName: profile.name,
      before: { name: profile.name },
    });
  }

  // ── Permission sets ────────────────────────────────────────────────────────────────────────
  private async setRow(tx: TenantTransaction, id: string) {
    return tx.prisma.permissionSet.findFirst({
      where: { id, kind: 'STANDARD', deletedAt: null },
      include: {
        ...GRANT_ROWS,
        _count: { select: { assignments: true, groupMemberships: true } },
      },
    });
  }

  async listSets(
    tx: TenantTransaction,
  ): Promise<{ items: z.infer<typeof PermissionSetSummary>[] }> {
    const rows = await tx.prisma.permissionSet.findMany({
      where: { kind: 'STANDARD', deletedAt: null },
      include: { _count: { select: { assignments: true, groupMemberships: true } } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return {
      items: rows.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        assignedUsers: s._count.assignments,
        groups: s._count.groupMemberships,
        version: s.version,
      })),
    };
  }

  async getSet(tx: TenantTransaction, id: string): Promise<z.infer<typeof PermissionSetDetail>> {
    const s = await this.setRow(tx, id);
    if (!s) throw errors.notFound('Permission set');
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      assignedUsers: s._count.assignments,
      groups: s._count.groupMemberships,
      version: s.version,
      grants: toGrants(s) as z.infer<typeof GrantsDto>,
    };
  }

  private async assertSetName(tx: TenantTransaction, name: string, except?: string) {
    if (
      await tx.prisma.permissionSet.findFirst({
        where: { kind: 'STANDARD', name, ...(except ? { NOT: { id: except } } : {}) },
      })
    )
      throw nameTaken();
  }

  async createSet(
    tx: TenantTransaction,
    input: z.infer<typeof CreatePermissionSetRequest>,
  ): Promise<z.infer<typeof PermissionSetDetail>> {
    const grants = input.grants
      ? validateGrants(input.grants, 'grant')
      : { system: [], objects: {}, fields: {} };
    await this.assertSetName(tx, input.name);
    const actor = tx.context.userId ?? null;
    const set = await tx.prisma.permissionSet.create({
      data: {
        tenantId: tx.context.tenantId,
        kind: 'STANDARD',
        name: input.name,
        description: input.description ?? null,
        createdBy: actor,
        updatedBy: actor,
      },
    });
    await writeGrants(tx, tx.context.tenantId, set.id, grants);
    await audit.setup(tx, {
      action: 'permission_set.created',
      entityType: 'permission_set',
      entityId: set.id,
      entityName: set.name,
      after: { name: set.name, grants: plain(grants) },
    });
    return this.getSet(tx, set.id);
  }

  async updateSet(
    tx: TenantTransaction,
    id: string,
    input: z.infer<typeof UpdateNamedRequest>,
  ): Promise<z.infer<typeof PermissionSetDetail>> {
    const before = await this.setRow(tx, id);
    assertVersion(before, input.version, 'Permission set');
    if (input.name) await this.assertSetName(tx, input.name, id);
    const updated = await tx.prisma.permissionSet.updateMany({
      where: { id, version: input.version },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        version: { increment: 1 },
        updatedBy: tx.context.userId ?? null,
      },
    });
    if (updated.count !== 1) assertVersion(null, input.version, 'Permission set');
    await audit.setup(tx, {
      action: 'permission_set.updated',
      entityType: 'permission_set',
      entityId: id,
      entityName: before.name,
      before: { name: before.name, description: before.description },
      after: {
        name: input.name ?? before.name,
        description: input.description ?? before.description,
      },
    });
    return this.getSet(tx, id);
  }

  async putSetGrants(
    tx: TenantTransaction,
    id: string,
    input: { version: number; grants: GrantsInput },
  ): Promise<z.infer<typeof PermissionSetDetail>> {
    const before = await this.setRow(tx, id);
    assertVersion(before, input.version, 'Permission set');
    const grants = validateGrants(input.grants, 'grant');
    const updated = await tx.prisma.permissionSet.updateMany({
      where: { id, version: input.version },
      data: { version: { increment: 1 }, updatedBy: tx.context.userId ?? null },
    });
    if (updated.count !== 1) assertVersion(null, input.version, 'Permission set');
    await replaceGrants(tx, id, grants);
    await audit.setup(tx, {
      action: 'permission_set.grants_changed',
      entityType: 'permission_set',
      entityId: id,
      entityName: before.name,
      before: plain(toGrants(before)),
      after: plain(grants),
    });
    return this.getSet(tx, id);
  }

  async removeSet(tx: TenantTransaction, id: string): Promise<void> {
    const set = await this.setRow(tx, id);
    if (!set) throw errors.notFound('Permission set');
    if (set._count.assignments) throw errors.conflict('Unassign this permission set first');
    if (set._count.groupMemberships)
      throw errors.conflict('Remove this permission set from its groups first');
    await tx.prisma.permissionSet.delete({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
    });
    await audit.setup(tx, {
      action: 'permission_set.deleted',
      entityType: 'permission_set',
      entityId: id,
      entityName: set.name,
      before: { name: set.name, grants: plain(toGrants(set)) },
    });
  }

  // ── Permission set groups ──────────────────────────────────────────────────────────────────
  async listGroups(
    tx: TenantTransaction,
  ): Promise<{ items: z.infer<typeof PermissionSetGroupDetail>[] }> {
    const rows = await tx.prisma.permissionSetGroup.findMany({
      where: { deletedAt: null },
      select: { id: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const items = [];
    for (const r of rows) items.push(await this.getGroup(tx, r.id));
    return { items };
  }

  async getGroup(
    tx: TenantTransaction,
    id: string,
  ): Promise<z.infer<typeof PermissionSetGroupDetail>> {
    const g = await tx.prisma.permissionSetGroup.findFirst({
      where: { id, deletedAt: null },
      include: {
        members: { select: { permissionSet: { select: { id: true, name: true } } } },
        mutingSet: { select: GRANT_ROWS },
        _count: { select: { assignments: true } },
      },
    });
    if (!g) throw errors.notFound('Permission set group');
    return {
      id: g.id,
      name: g.name,
      description: g.description,
      permissionSets: g.members
        .map((m) => m.permissionSet)
        .sort((a, b) => a.name.localeCompare(b.name)),
      muting: g.mutingSet ? (toGrants(g.mutingSet) as z.infer<typeof GrantsDto>) : null,
      assignedUsers: g._count.assignments,
      version: g.version,
    };
  }

  private async assertGroupName(tx: TenantTransaction, name: string, except?: string) {
    if (
      await tx.prisma.permissionSetGroup.findFirst({
        where: { name, ...(except ? { NOT: { id: except } } : {}) },
      })
    )
      throw nameTaken();
  }

  private async replaceMembers(tx: TenantTransaction, groupId: string, setIds: string[]) {
    const ids = [...new Set(setIds)];
    const valid = await tx.prisma.permissionSet.count({
      where: { id: { in: ids }, kind: 'STANDARD', deletedAt: null },
    });
    if (valid !== ids.length)
      throw errors.validation([
        {
          field: 'permissionSetIds',
          code: 'not_found',
          message: 'Some permission sets do not exist',
        },
      ]);
    const { tenantId, userId } = tx.context;
    await tx.prisma.permissionSetGroupMember.deleteMany({ where: { groupId } });
    await tx.prisma.permissionSetGroupMember.createMany({
      data: ids.map((permissionSetId) => ({
        tenantId,
        groupId,
        permissionSetId,
        createdBy: userId ?? null,
      })),
    });
  }

  /** Set, replace or clear the group's muting set (a MUTING set only that group uses). */
  private async setMuting(
    tx: TenantTransaction,
    group: { id: string; mutingSetId: string | null },
    muting: GrantsInput | null,
  ) {
    const { tenantId } = tx.context;
    if (muting === null) {
      if (!group.mutingSetId) return;
      await tx.prisma.permissionSetGroup.update({
        where: { tenantId_id: { tenantId, id: group.id } },
        data: { mutingSetId: null },
      });
      await tx.prisma.permissionSet.delete({
        where: { tenantId_id: { tenantId, id: group.mutingSetId } },
      });
      return;
    }
    const grants = validateGrants(muting, 'muting');
    if (group.mutingSetId) {
      await replaceGrants(tx, group.mutingSetId, grants);
      return;
    }
    const set = await tx.prisma.permissionSet.create({
      data: { tenantId, kind: 'MUTING', name: `muting:${group.id}` },
    });
    await writeGrants(tx, tenantId, set.id, grants);
    await tx.prisma.permissionSetGroup.update({
      where: { tenantId_id: { tenantId, id: group.id } },
      data: { mutingSetId: set.id },
    });
  }

  async createGroup(
    tx: TenantTransaction,
    input: z.infer<typeof CreatePermissionSetGroupRequest>,
  ): Promise<z.infer<typeof PermissionSetGroupDetail>> {
    await this.assertGroupName(tx, input.name);
    const actor = tx.context.userId ?? null;
    const group = await tx.prisma.permissionSetGroup.create({
      data: {
        tenantId: tx.context.tenantId,
        name: input.name,
        description: input.description ?? null,
        createdBy: actor,
        updatedBy: actor,
      },
    });
    await this.replaceMembers(tx, group.id, input.permissionSetIds);
    if (input.muting) await this.setMuting(tx, group, input.muting);
    const after = await this.getGroup(tx, group.id);
    await audit.setup(tx, {
      action: 'permission_set_group.created',
      entityType: 'permission_set_group',
      entityId: group.id,
      entityName: group.name,
      after: plain(after),
    });
    return after;
  }

  async updateGroup(
    tx: TenantTransaction,
    id: string,
    input: z.infer<typeof UpdatePermissionSetGroupRequest>,
  ): Promise<z.infer<typeof PermissionSetGroupDetail>> {
    const current = await tx.prisma.permissionSetGroup.findFirst({
      where: { id, deletedAt: null },
    });
    assertVersion(current, input.version, 'Permission set group');
    if (input.name) await this.assertGroupName(tx, input.name, id);
    const before = await this.getGroup(tx, id);
    const updated = await tx.prisma.permissionSetGroup.updateMany({
      where: { id, version: input.version },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        version: { increment: 1 },
        updatedBy: tx.context.userId ?? null,
      },
    });
    if (updated.count !== 1) assertVersion(null, input.version, 'Permission set group');
    if (input.permissionSetIds) await this.replaceMembers(tx, id, input.permissionSetIds);
    if (input.muting !== undefined) await this.setMuting(tx, current, input.muting);
    const after = await this.getGroup(tx, id);
    await audit.setup(tx, {
      action: 'permission_set_group.updated',
      entityType: 'permission_set_group',
      entityId: id,
      entityName: before.name,
      before: plain(before),
      after: plain(after),
    });
    return after;
  }

  async removeGroup(tx: TenantTransaction, id: string): Promise<void> {
    const group = await tx.prisma.permissionSetGroup.findFirst({
      where: { id, deletedAt: null },
      include: { _count: { select: { assignments: true } } },
    });
    if (!group) throw errors.notFound('Permission set group');
    if (group._count.assignments) throw errors.conflict('Unassign this permission set group first');
    const { tenantId } = tx.context;
    await tx.prisma.permissionSetGroup.delete({ where: { tenantId_id: { tenantId, id } } });
    if (group.mutingSetId)
      await tx.prisma.permissionSet.delete({
        where: { tenantId_id: { tenantId, id: group.mutingSetId } },
      });
    await audit.setup(tx, {
      action: 'permission_set_group.deleted',
      entityType: 'permission_set_group',
      entityId: id,
      entityName: group.name,
      before: { name: group.name },
    });
  }
}
