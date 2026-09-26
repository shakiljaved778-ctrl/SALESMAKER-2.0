import { camelCase, flsFields, STANDARD_OBJECTS, type StandardObjectApiName } from '@sm/metadata';

/** System permissions (§6.2 layer 2). Names are stored as-is in `system_permission.name`. */
export const SYSTEM_PERMISSIONS = [
  'manage_users',
  'customize_application',
  'view_setup',
  'import_records',
  'export_reports',
  'mass_update',
  'transfer_records',
  'run_reports',
  'manage_dashboards',
  'api_enabled',
  'view_all_data',
  'modify_all_data',
  'manage_billing',
  'use_ai_assistant',
  'approve_ai_actions',
  'manage_automations',
  'manage_territories',
  'view_wallboard',
  'bypass_calling_window',
] as const;
export type SystemPermissionName = (typeof SYSTEM_PERMISSIONS)[number];

/** Granted to no built-in profile: an admin must assign it deliberately (§6.2). */
export const NEVER_DEFAULT: readonly SystemPermissionName[] = ['bypass_calling_window'];

export function isSystemPermission(name: string): name is SystemPermissionName {
  return (SYSTEM_PERMISSIONS as readonly string[]).includes(name);
}

export function systemPermissionLabelKey(name: SystemPermissionName): string {
  return `permissions.system.${camelCase(name)}`;
}

/** Object access flags, as stored in `object_permission` (§6.2 layer 3). */
export interface ObjectAccess {
  read: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  viewAll: boolean;
  modifyAll: boolean;
}

/** Field access, as stored in `field_permission` (§6.2 layer 5). */
export interface FieldAccess {
  read: boolean;
  edit: boolean;
}

export const NO_OBJECT_ACCESS: ObjectAccess = Object.freeze({
  read: false,
  create: false,
  edit: false,
  delete: false,
  viewAll: false,
  modifyAll: false,
});

/**
 * Close object access under its dependencies, the same rules the database enforces: create and
 * edit need read, delete needs edit, view all needs read, modify all needs delete and view all.
 */
export function normaliseObjectAccess(access: Partial<ObjectAccess>): ObjectAccess {
  const modifyAll = access.modifyAll ?? false;
  const viewAll = (access.viewAll ?? false) || modifyAll;
  const del = (access.delete ?? false) || modifyAll;
  const edit = (access.edit ?? false) || del;
  const create = access.create ?? false;
  const read = (access.read ?? false) || create || edit || viewAll;
  return { read, create, edit, delete: del, viewAll, modifyAll };
}

/** A grant bundle: what one permission set (or a profile's own set) contains. */
export interface Grants {
  system: SystemPermissionName[];
  objects: Partial<Record<string, ObjectAccess>>;
  /** `fields[object][field]` */
  fields: Partial<Record<string, Partial<Record<string, FieldAccess>>>>;
}

export type DefaultProfileKey = 'system_administrator' | 'standard_user' | 'read_only';

export interface DefaultProfile {
  key: DefaultProfileKey;
  nameKey: string;
  descriptionKey: string;
  grants: Grants;
}

function grantsFor(
  system: readonly SystemPermissionName[],
  object: (name: StandardObjectApiName) => Partial<ObjectAccess>,
  field: FieldAccess,
): Grants {
  const grants: Grants = { system: [...system], objects: {}, fields: {} };
  for (const o of STANDARD_OBJECTS) {
    const access = normaliseObjectAccess(object(o.apiName));
    if (!access.read) continue;
    grants.objects[o.apiName] = access;
    grants.fields[o.apiName] = Object.fromEntries(
      flsFields(o.apiName).map((f) => [f.apiName, { ...field }]),
    );
  }
  return grants;
}

const CORE_SALES: readonly StandardObjectApiName[] = [
  'lead',
  'account',
  'contact',
  'opportunity',
  'activity',
  'quote',
];

/**
 * The profiles every new organisation starts with (P01 plan T04). System Administrator holds every
 * system permission except the ones that are never granted by default, and Modify All on every
 * standard object. Standard User works their own and shared records. Read Only can look, not touch.
 */
export const DEFAULT_PROFILES: readonly DefaultProfile[] = [
  {
    key: 'system_administrator',
    nameKey: 'permissions.profiles.systemAdministrator.name',
    descriptionKey: 'permissions.profiles.systemAdministrator.description',
    grants: grantsFor(
      SYSTEM_PERMISSIONS.filter((p) => !NEVER_DEFAULT.includes(p)),
      () => ({ read: true, create: true, modifyAll: true }),
      { read: true, edit: true },
    ),
  },
  {
    key: 'standard_user',
    nameKey: 'permissions.profiles.standardUser.name',
    descriptionKey: 'permissions.profiles.standardUser.description',
    grants: grantsFor(
      ['run_reports', 'use_ai_assistant'],
      (o) =>
        CORE_SALES.includes(o)
          ? { read: true, create: true, edit: true, delete: true }
          : o === 'contract' || o === 'order'
            ? { read: true, create: true, edit: true }
            : { read: true },
      { read: true, edit: true },
    ),
  },
  {
    key: 'read_only',
    nameKey: 'permissions.profiles.readOnly.name',
    descriptionKey: 'permissions.profiles.readOnly.description',
    grants: grantsFor(['run_reports'], () => ({ read: true }), { read: true, edit: false }),
  },
];
