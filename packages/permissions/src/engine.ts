import { standardField } from '@sm/metadata';

import {
  isSystemPermission,
  NO_OBJECT_ACCESS,
  normaliseObjectAccess,
  type FieldAccess,
  type Grants,
  type ObjectAccess,
  type SystemPermissionName,
} from './catalogue.js';

/** Where a user's permissions come from (§6.2): all additive, except each group's muting set. */
export interface PermissionSource {
  profile: Grants;
  /** Directly assigned permission sets. */
  sets: Grants[];
  /** Assigned permission set groups: their sets, minus their own muting set. */
  groups: { sets: Grants[]; muting?: Grants | undefined }[];
}

/** The union of every grant a user holds, before system-wide overrides. */
export interface EffectivePermissions {
  system: ReadonlySet<SystemPermissionName>;
  objects: Readonly<Record<string, ObjectAccess>>;
  fields: Readonly<Record<string, Readonly<Record<string, FieldAccess>>>>;
}

const OBJECT_FLAGS = ['read', 'create', 'edit', 'delete', 'viewAll', 'modifyAll'] as const;

function orObject(a: ObjectAccess | undefined, b: ObjectAccess | undefined): ObjectAccess {
  const out = { ...NO_OBJECT_ACCESS };
  for (const f of OBJECT_FLAGS) out[f] = Boolean(a?.[f]) || Boolean(b?.[f]);
  return out;
}

/**
 * Drop every flag whose prerequisite is gone (the dependency rules run downwards): muting Delete
 * also removes Modify All, muting Read removes everything.
 */
export function restrictObjectAccess(access: ObjectAccess): ObjectAccess {
  const read = access.read;
  const create = access.create && read;
  const edit = access.edit && read;
  const del = access.delete && edit;
  const viewAll = access.viewAll && read;
  const modifyAll = access.modifyAll && del && viewAll;
  return { read, create, edit, delete: del, viewAll, modifyAll };
}

interface Accumulator {
  system: Set<SystemPermissionName>;
  objects: Record<string, ObjectAccess>;
  fields: Record<string, Record<string, FieldAccess>>;
}

function empty(): Accumulator {
  return { system: new Set(), objects: {}, fields: {} };
}

function add(acc: Accumulator, grants: Grants): void {
  for (const name of grants.system) if (isSystemPermission(name)) acc.system.add(name);
  for (const [object, access] of Object.entries(grants.objects)) {
    if (access) acc.objects[object] = orObject(acc.objects[object], normaliseObjectAccess(access));
  }
  for (const [object, byField] of Object.entries(grants.fields)) {
    const target = (acc.fields[object] ??= {});
    for (const [field, access] of Object.entries(byField ?? {})) {
      if (!access) continue;
      const prev = target[field];
      const edit = Boolean(prev?.edit) || access.edit;
      target[field] = { read: Boolean(prev?.read) || access.read || edit, edit };
    }
  }
}

/** Remove what a muting set names, then restore the dependency rules. */
function mute(acc: Accumulator, muting: Grants): void {
  for (const name of muting.system) acc.system.delete(name);
  for (const [object, muted] of Object.entries(muting.objects)) {
    const current = acc.objects[object];
    if (!current || !muted) continue;
    const next = { ...current };
    for (const f of OBJECT_FLAGS) if (muted[f]) next[f] = false;
    acc.objects[object] = restrictObjectAccess(next);
  }
  for (const [object, byField] of Object.entries(muting.fields)) {
    const target = acc.fields[object];
    if (!target) continue;
    for (const [field, muted] of Object.entries(byField ?? {})) {
      const current = target[field];
      if (!current || !muted) continue;
      const read = current.read && !muted.read;
      target[field] = { read, edit: read && current.edit && !muted.edit };
    }
  }
}

function merge(into: Accumulator, from: Accumulator): void {
  add(into, { system: [...from.system], objects: from.objects, fields: from.fields });
}

/**
 * Effective permissions (§6.2, ADR-0007): profile ∪ assigned sets ∪ each assigned group's sets
 * minus that group's muting set. A muting set only removes what its own group grants, so the
 * same permission from the profile or another set survives. Permission sets never deny.
 */
export function effectivePermissions(source: PermissionSource): EffectivePermissions {
  const acc = empty();
  add(acc, source.profile);
  for (const set of source.sets) add(acc, set);
  for (const group of source.groups) {
    const own = empty();
    for (const set of group.sets) add(own, set);
    if (group.muting) mute(own, group.muting);
    merge(acc, own);
  }
  return acc;
}

export function hasSystemPermission(
  permissions: EffectivePermissions,
  name: SystemPermissionName,
): boolean {
  return permissions.system.has(name);
}

/**
 * Object access (§6.2 layer 3) after the data-wide system permissions: `view_all_data` gives Read
 * and View All on every object; `modify_all_data` gives everything. Modify All (object or data-wide)
 * implies Read, Create, Edit, Delete and View All (P01 plan §3.1).
 */
export function objectAccess(permissions: EffectivePermissions, object: string): ObjectAccess {
  let access = permissions.objects[object] ?? NO_OBJECT_ACCESS;
  if (permissions.system.has('view_all_data'))
    access = orObject(access, normaliseObjectAccess({ read: true, viewAll: true }));
  if (permissions.system.has('modify_all_data')) access = { ...access, modifyAll: true };
  return access.modifyAll
    ? { read: true, create: true, edit: true, delete: true, viewAll: true, modifyAll: true }
    : access;
}

const NO_FIELD_ACCESS: FieldAccess = Object.freeze({ read: false, edit: false });

/**
 * Field access (§6.2 layer 5). Nothing on an object the user cannot read. Standard system fields
 * (ids, audit stamps, conversion links, roll-ups) are always readable and never editable; required
 * standard fields are readable and editable whenever the object is editable. Every other field,
 * standard or custom, follows FLS: the most permissive grant wins, and Edit implies Read.
 * Data-wide permissions do not bypass FLS (Salesforce semantics).
 */
export function fieldAccess(
  permissions: EffectivePermissions,
  object: string,
  field: string,
): FieldAccess {
  const obj = objectAccess(permissions, object);
  if (!obj.read) return NO_FIELD_ACCESS;
  const standard = standardField(object, field);
  if (standard?.system) return { read: true, edit: false };
  const canWrite = obj.edit || obj.create;
  if (standard?.required) return { read: true, edit: canWrite };
  const granted = permissions.fields[object]?.[field] ?? NO_FIELD_ACCESS;
  return { read: granted.read, edit: granted.edit && canWrite };
}

/** A JSON-safe form for caching (§6.4: keyed by permVersion). */
export interface SerialisedPermissions {
  system: SystemPermissionName[];
  objects: Record<string, ObjectAccess>;
  fields: Record<string, Record<string, FieldAccess>>;
}

export function serialisePermissions(p: EffectivePermissions): SerialisedPermissions {
  return {
    system: [...p.system].sort(),
    objects: { ...p.objects },
    fields: Object.fromEntries(Object.entries(p.fields).map(([o, f]) => [o, { ...f }])),
  };
}

export function deserialisePermissions(s: SerialisedPermissions): EffectivePermissions {
  return {
    system: new Set(s.system.filter(isSystemPermission)),
    objects: s.objects,
    fields: s.fields,
  };
}
