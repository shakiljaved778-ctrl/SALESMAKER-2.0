import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROFILES,
  deserialisePermissions,
  effectivePermissions,
  fieldAccess,
  hasSystemPermission,
  normaliseObjectAccess,
  objectAccess,
  PermissionCache,
  restrictObjectAccess,
  serialisePermissions,
  type CacheStore,
  type Grants,
  type ObjectAccess,
  type PermissionSource,
  VersionedCache,
} from '../src/index.js';

const grants = (g: Partial<Grants> = {}): Grants => ({ system: [], objects: {}, fields: {}, ...g });
const source = (s: Partial<PermissionSource> = {}): PermissionSource => ({
  profile: grants(),
  sets: [],
  groups: [],
  ...s,
});
const access = (flags: Partial<ObjectAccess>): ObjectAccess => normaliseObjectAccess(flags);
const NONE = normaliseObjectAccess({});
const ALL = { read: true, create: true, edit: true, delete: true, viewAll: true, modifyAll: true };

describe('effectivePermissions: union (§6.2, sets are additive only)', () => {
  it('combines profile, sets and groups, flag by flag', () => {
    const eff = effectivePermissions(
      source({
        profile: grants({ system: ['run_reports'], objects: { lead: access({ read: true }) } }),
        sets: [
          grants({ system: ['export_reports'], objects: { lead: access({ edit: true }) } }),
          grants({ objects: { account: access({ create: true }) } }),
        ],
        groups: [{ sets: [grants({ objects: { lead: access({ delete: true }) } })] }],
      }),
    );
    expect([...eff.system].sort()).toEqual(['export_reports', 'run_reports']);
    expect(eff.objects['lead']).toEqual(access({ delete: true }));
    expect(eff.objects['account']).toEqual(access({ create: true }));
  });

  it('closes grants under their dependencies and ignores unknown system permissions', () => {
    const eff = effectivePermissions(
      source({
        profile: grants({
          system: ['run_reports', 'launch_rockets' as never],
          objects: { lead: { ...NONE, modifyAll: true } },
          fields: { lead: { email: { read: false, edit: true } } },
        }),
      }),
    );
    expect([...eff.system]).toEqual(['run_reports']);
    expect(eff.objects['lead']).toMatchObject({ read: true, delete: true, viewAll: true });
    expect(eff.fields['lead']?.['email']).toEqual({ read: true, edit: true });
  });

  it('takes the most permissive field access across grants', () => {
    const eff = effectivePermissions(
      source({
        profile: grants({ fields: { lead: { email: { read: true, edit: false } } } }),
        sets: [
          grants({ fields: { lead: { email: { read: true, edit: true }, phone: undefined } } }),
        ],
      }),
    );
    expect(eff.fields['lead']).toEqual({ email: { read: true, edit: true } });
  });
});

describe('effectivePermissions: muting (§6.2)', () => {
  const groupGrants = grants({
    system: ['export_reports', 'mass_update'],
    objects: { lead: access({ modifyAll: true }), account: access({ read: true }) },
    fields: { lead: { email: { read: true, edit: true }, phone: { read: true, edit: true } } },
  });

  it('removes only what the muting set names, and whatever depended on it', () => {
    const eff = effectivePermissions(
      source({
        groups: [
          {
            sets: [groupGrants],
            muting: grants({
              system: ['export_reports'],
              objects: { lead: { ...NONE, delete: true }, contact: { ...NONE, read: true } },
              fields: {
                lead: { email: { read: false, edit: true }, mobile: { read: true, edit: true } },
                account: { name: { read: true, edit: true } },
              },
            }),
          },
        ],
      }),
    );
    expect([...eff.system]).toEqual(['mass_update']);
    // Muting Delete also removes Modify All; Read, Edit and View All stay.
    expect(eff.objects['lead']).toEqual({
      read: true,
      create: false,
      edit: true,
      delete: false,
      viewAll: true,
      modifyAll: false,
    });
    expect(eff.objects['account']).toEqual(access({ read: true }));
    expect(eff.fields['lead']).toEqual({
      email: { read: true, edit: false },
      phone: { read: true, edit: true },
    });
  });

  it('muting Read removes everything on that object and field', () => {
    const eff = effectivePermissions(
      source({
        groups: [
          {
            sets: [groupGrants],
            muting: grants({
              objects: { lead: { ...NONE, read: true } },
              fields: { lead: { phone: { read: true, edit: false } } },
            }),
          },
        ],
      }),
    );
    expect(eff.objects['lead']).toEqual(NONE);
    expect(eff.fields['lead']?.['phone']).toEqual({ read: false, edit: false });
  });

  it('never removes what the profile, another set or another group grants', () => {
    const muting = grants({
      system: ['export_reports'],
      objects: { lead: { ...NONE, read: true } },
      fields: { lead: { email: { read: true, edit: true } } },
    });
    const eff = effectivePermissions(
      source({
        profile: grants({
          system: ['export_reports'],
          objects: { lead: access({ read: true }) },
          fields: { lead: { email: { read: true, edit: false } } },
        }),
        groups: [
          { sets: [groupGrants], muting },
          { sets: [grants({ objects: { lead: access({ edit: true }) } })] },
        ],
      }),
    );
    expect(hasSystemPermission(eff, 'export_reports')).toBe(true);
    expect(eff.objects['lead']).toEqual(access({ edit: true }));
    expect(eff.fields['lead']?.['email']).toEqual({ read: true, edit: false });
  });
});

describe('restrictObjectAccess', () => {
  it.each([
    [{ ...ALL, read: false }, NONE],
    [
      { ...ALL, edit: false },
      { ...NONE, read: true, create: true, viewAll: true },
    ],
    [
      { ...ALL, viewAll: false },
      { ...ALL, viewAll: false, modifyAll: false },
    ],
    [ALL, ALL],
  ])('drops dependants of a missing flag (%#)', (input, expected) => {
    expect(restrictObjectAccess(input)).toEqual(expected);
  });
});

describe('objectAccess', () => {
  it('returns nothing for an object with no grant', () => {
    expect(objectAccess(effectivePermissions(source()), 'lead')).toEqual(NONE);
  });

  it('expands Modify All to every flag, including Create (P01 plan §3.1)', () => {
    const eff = effectivePermissions(
      source({ profile: grants({ objects: { lead: access({ modifyAll: true }) } }) }),
    );
    expect(objectAccess(eff, 'lead')).toEqual(ALL);
  });

  it('applies view_all_data and modify_all_data to every object, custom ones included', () => {
    const viewer = effectivePermissions(
      source({
        profile: grants({ system: ['view_all_data'], objects: { lead: access({ edit: true }) } }),
      }),
    );
    expect(objectAccess(viewer, 'lead')).toEqual({ ...access({ edit: true }), viewAll: true });
    expect(objectAccess(viewer, 'project__c')).toEqual(access({ viewAll: true }));
    const modifier = effectivePermissions(
      source({ profile: grants({ system: ['modify_all_data'] }) }),
    );
    expect(objectAccess(modifier, 'project__c')).toEqual(ALL);
  });
});

describe('fieldAccess (§6.2 layer 5)', () => {
  const eff = effectivePermissions(
    source({
      profile: grants({
        objects: { lead: access({ edit: true }), account: access({ read: true }) },
        fields: {
          lead: { email: { read: true, edit: true }, phone: { read: true, edit: false } },
          account: { website: { read: true, edit: true } },
          project__c: { budget__c: { read: true, edit: true } },
        },
      }),
    }),
  );

  it('hides every field of an object the user cannot read', () => {
    expect(fieldAccess(eff, 'contact', 'email')).toEqual({ read: false, edit: false });
    expect(fieldAccess(eff, 'project__c', 'budget__c')).toEqual({ read: false, edit: false });
  });

  it('keeps system fields readable and never editable', () => {
    expect(fieldAccess(eff, 'lead', 'id')).toEqual({ read: true, edit: false });
    expect(fieldAccess(eff, 'lead', 'converted_at')).toEqual({ read: true, edit: false });
  });

  it('keeps required fields editable exactly when the object is', () => {
    expect(fieldAccess(eff, 'lead', 'last_name')).toEqual({ read: true, edit: true });
    expect(fieldAccess(eff, 'account', 'name')).toEqual({ read: true, edit: false });
  });

  it('follows FLS for other fields, never editable on a read-only object', () => {
    expect(fieldAccess(eff, 'lead', 'email')).toEqual({ read: true, edit: true });
    expect(fieldAccess(eff, 'lead', 'phone')).toEqual({ read: true, edit: false });
    expect(fieldAccess(eff, 'lead', 'website')).toEqual({ read: false, edit: false });
    expect(fieldAccess(eff, 'account', 'website')).toEqual({ read: true, edit: false });
  });

  it('is not bypassed by data-wide permissions', () => {
    const admin = effectivePermissions(
      source({ profile: grants({ system: ['modify_all_data'] }) }),
    );
    expect(fieldAccess(admin, 'lead', 'email')).toEqual({ read: false, edit: false });
    expect(fieldAccess(admin, 'lead', 'last_name')).toEqual({ read: true, edit: true });
  });
});

describe('default profiles through the engine', () => {
  const profile = (key: string) => {
    const p = DEFAULT_PROFILES.find((d) => d.key === key);
    if (!p) throw new Error(key);
    return effectivePermissions(source({ profile: p.grants }));
  };

  it('let the administrator do everything but bypass the calling window', () => {
    const admin = profile('system_administrator');
    expect(objectAccess(admin, 'opportunity')).toEqual(ALL);
    expect(fieldAccess(admin, 'opportunity', 'amount')).toEqual({ read: true, edit: true });
    expect(hasSystemPermission(admin, 'view_setup')).toBe(true);
    expect(hasSystemPermission(admin, 'bypass_calling_window')).toBe(false);
  });

  it('keep Read Only from editing anything', () => {
    const ro = profile('read_only');
    expect(objectAccess(ro, 'lead')).toEqual(access({ read: true }));
    expect(fieldAccess(ro, 'lead', 'email')).toEqual({ read: true, edit: false });
    expect(fieldAccess(ro, 'lead', 'last_name')).toEqual({ read: true, edit: false });
    expect(hasSystemPermission(ro, 'view_setup')).toBe(false);
  });
});

describe('PermissionCache', () => {
  class MemoryStore implements CacheStore {
    readonly data = new Map<string, string>();
    failing = false;
    get(key: string) {
      return this.failing
        ? Promise.reject(new Error('down'))
        : Promise.resolve(this.data.get(key) ?? null);
    }
    set(key: string, value: string) {
      if (this.failing) return Promise.reject(new Error('down'));
      this.data.set(key, value);
      return Promise.resolve('OK');
    }
  }

  const eff = effectivePermissions(
    source({
      profile: grants({
        system: ['run_reports'],
        objects: { lead: access({ read: true }) },
        fields: { lead: { email: { read: true, edit: false } } },
      }),
    }),
  );

  it('computes once per permVersion and round-trips through JSON', async () => {
    const store = new MemoryStore();
    const cache = new PermissionCache(store);
    let computed = 0;
    const compute = () => {
      computed += 1;
      return Promise.resolve(eff);
    };
    const first = await cache.getOrCompute('t1', 'u1', 7, compute);
    const second = await cache.getOrCompute('t1', 'u1', 7, compute);
    expect(computed).toBe(1);
    expect(serialisePermissions(second)).toEqual(serialisePermissions(first));
    expect(store.data.has(PermissionCache.key('t1', 'u1', 7))).toBe(true);
    await cache.getOrCompute('t1', 'u1', 8, compute); // a bump means a new key
    expect(computed).toBe(2);
  });

  it('falls back to computing when the store is down, and reports it', async () => {
    const store = new MemoryStore();
    store.failing = true;
    const errors: unknown[] = [];
    const cache = new PermissionCache(store, 60, (e) => errors.push(e));
    expect(await cache.getOrCompute('t1', 'u1', 1, () => Promise.resolve(eff))).toBe(eff);
    expect(errors).toHaveLength(2);
  });

  it('drops unknown system permissions when reading an old cache entry', () => {
    const restored = deserialisePermissions({
      system: ['run_reports', 'gone' as never],
      objects: {},
      fields: {},
    });
    expect([...restored.system]).toEqual(['run_reports']);
  });
});

describe('VersionedCache', () => {
  it('namespaces keys and round-trips plain JSON values', async () => {
    const data = new Map<string, string>();
    const store: CacheStore = {
      get: (k) => Promise.resolve(data.get(k) ?? null),
      set: (k, v) => {
        data.set(k, v);
        return Promise.resolve('OK');
      },
    };
    const cache = new VersionedCache<{ ids: string[] }>(store, 'principals');
    expect(cache.key('t', 'u', 3)).toBe('principals:t:u:3');
    await cache.getOrCompute('t', 'u', 3, () => Promise.resolve({ ids: ['a'] }));
    expect(
      await cache.getOrCompute('t', 'u', 3, () => Promise.reject(new Error('not called'))),
    ).toEqual({ ids: ['a'] });
  });
});
