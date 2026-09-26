import { flatten } from '@sm/i18n';
import en from '@sm/i18n/messages/en.json' with { type: 'json' };
import { flsFields, STANDARD_OBJECTS } from '@sm/metadata';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROFILES,
  isSystemPermission,
  NEVER_DEFAULT,
  normaliseObjectAccess,
  SYSTEM_PERMISSIONS,
  systemPermissionLabelKey,
  type DefaultProfileKey,
} from '../src/index.js';

const labels = new Map(flatten(en));
const profile = (key: DefaultProfileKey) => {
  const p = DEFAULT_PROFILES.find((d) => d.key === key);
  if (!p) throw new Error(key);
  return p;
};

describe('system permissions (§6.2)', () => {
  it('are unique, snake_case and labelled', () => {
    expect(new Set(SYSTEM_PERMISSIONS).size).toBe(SYSTEM_PERMISSIONS.length);
    for (const p of SYSTEM_PERMISSIONS) {
      expect(p).toMatch(/^[a-z]+(_[a-z]+)*$/);
      expect(labels.has(systemPermissionLabelKey(p)), p).toBe(true);
    }
    expect(isSystemPermission('view_setup')).toBe(true);
    expect(isSystemPermission('drop_database')).toBe(false);
  });
});

describe('normaliseObjectAccess', () => {
  it('closes access under the same dependencies the database enforces', () => {
    expect(normaliseObjectAccess({})).toEqual({
      read: false,
      create: false,
      edit: false,
      delete: false,
      viewAll: false,
      modifyAll: false,
    });
    expect(normaliseObjectAccess({ modifyAll: true })).toEqual({
      read: true,
      create: false,
      edit: true,
      delete: true,
      viewAll: true,
      modifyAll: true,
    });
    expect(normaliseObjectAccess({ create: true })).toMatchObject({ read: true, edit: false });
    expect(normaliseObjectAccess({ delete: true })).toMatchObject({ read: true, edit: true });
    expect(normaliseObjectAccess({ viewAll: true })).toMatchObject({ read: true, edit: false });
  });
});

describe('default profiles', () => {
  it('are the three built-ins, each with a labelled name and description', () => {
    expect(DEFAULT_PROFILES.map((p) => p.key)).toEqual([
      'system_administrator',
      'standard_user',
      'read_only',
    ]);
    for (const p of DEFAULT_PROFILES) {
      expect(labels.has(p.nameKey), p.nameKey).toBe(true);
      expect(labels.has(p.descriptionKey), p.descriptionKey).toBe(true);
    }
  });

  it('never grant a never-by-default permission, and only known ones', () => {
    for (const p of DEFAULT_PROFILES) {
      for (const s of p.grants.system) {
        expect(isSystemPermission(s)).toBe(true);
        expect(NEVER_DEFAULT).not.toContain(s);
      }
    }
  });

  it('give the administrator everything else, Modify All everywhere and full FLS', () => {
    const admin = profile('system_administrator').grants;
    expect(admin.system.length).toBe(SYSTEM_PERMISSIONS.length - NEVER_DEFAULT.length);
    for (const o of STANDARD_OBJECTS) {
      expect(admin.objects[o.apiName], o.apiName).toMatchObject({ create: true, modifyAll: true });
      for (const f of flsFields(o.apiName))
        expect(admin.fields[o.apiName]?.[f.apiName]).toEqual({ read: true, edit: true });
    }
  });

  it('let a standard user work sales records but only read the catalogue and campaigns', () => {
    const std = profile('standard_user').grants;
    expect(std.system).toEqual(['run_reports', 'use_ai_assistant']);
    expect(std.objects['opportunity']).toMatchObject({ delete: true, viewAll: false });
    expect(std.objects['contract']).toMatchObject({ edit: true, delete: false });
    expect(std.objects['product']).toMatchObject({ read: true, create: false, edit: false });
    expect(std.objects['campaign']).toMatchObject({ read: true, edit: false });
  });

  it('keep Read Only to reading, with read-only FLS', () => {
    const ro = profile('read_only').grants;
    for (const o of STANDARD_OBJECTS) {
      expect(ro.objects[o.apiName]).toEqual(normaliseObjectAccess({ read: true }));
      for (const access of Object.values(ro.fields[o.apiName] ?? {}))
        expect(access).toEqual({ read: true, edit: false });
    }
  });
});
