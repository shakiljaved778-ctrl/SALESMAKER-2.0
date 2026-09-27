import { describe, expect, it } from 'vitest';

import {
  isSortable,
  MetadataCache,
  MetadataIndex,
  normaliseValue,
  type FieldMeta,
  type ObjectMeta,
  type TenantMetadata,
} from '../src/index.js';
import type { FieldType } from '../src/types.js';

function field(type: FieldType, extra: Partial<FieldMeta> = {}): FieldMeta {
  return {
    id: 'f',
    apiName: 'x',
    type,
    isStandard: false,
    label: null,
    labelKey: null,
    description: null,
    helpText: null,
    required: false,
    system: false,
    unique: false,
    externalId: false,
    searchable: false,
    indexed: false,
    trackHistory: false,
    length: null,
    precision: null,
    scale: null,
    referenceTo: [],
    relationshipName: null,
    defaultValue: null,
    formula: null,
    formulaReturnType: null,
    picklistValues: [],
    storage: { kind: 'custom', key: 'x' },
    ...extra,
  };
}
const value = (type: FieldType, raw: unknown, extra: Partial<FieldMeta> = {}) =>
  normaliseValue(field(type, extra), raw);
const pick = (...values: string[]) =>
  values.map((apiValue, i) => ({
    apiValue,
    label: null,
    labelKey: null,
    category: null,
    active: apiValue !== 'retired',
    isDefault: i === 0,
  }));

describe('normaliseValue (§5.3)', () => {
  it('refuses writes to computed and platform fields', () => {
    for (const type of ['id', 'auto_number', 'formula', 'rollup_summary'] as const)
      expect(value(type, 'x')).toEqual({ ok: false, code: 'read_only' });
    expect(value('text', 'x', { system: true })).toEqual({ ok: false, code: 'read_only' });
  });

  it('clears with null or an empty string; checkboxes clear to false', () => {
    expect(value('text', null)).toEqual({ ok: true, value: null });
    expect(value('number', '')).toEqual({ ok: true, value: null });
    expect(value('checkbox', null)).toEqual({ ok: true, value: false });
    expect(value('checkbox', '')).toEqual({ ok: false, code: 'invalid_type' });
  });

  it('checks text lengths against the field or the type default', () => {
    expect(value('text', 'a'.repeat(255))).toMatchObject({ ok: true });
    expect(value('text', 'a'.repeat(256))).toEqual({ ok: false, code: 'too_long' });
    expect(value('text', 'abcd', { length: 3 })).toEqual({ ok: false, code: 'too_long' });
    expect(value('long_text', 'a'.repeat(5000))).toMatchObject({ ok: true });
    expect(value('text', 42)).toEqual({ ok: false, code: 'invalid_type' });
  });

  it('keeps money and numbers as rounded decimal strings, never floats', () => {
    expect(value('currency', '1250.505')).toEqual({ ok: true, value: '1250.51' });
    expect(value('currency', 0.1)).toEqual({ ok: true, value: '0.10' });
    expect(value('number', '7.5')).toEqual({ ok: true, value: '8' });
    expect(value('number', '3.14159', { scale: 3 })).toEqual({ ok: true, value: '3.142' });
    expect(value('percent', '-12.5')).toEqual({ ok: true, value: '-12.50' });
    expect(value('number', '1e5')).toEqual({ ok: false, code: 'invalid_format' });
    expect(value('number', Number.NaN)).toEqual({ ok: false, code: 'invalid_type' });
    expect(value('currency', '100', { precision: 4, scale: 2 })).toEqual({
      ok: false,
      code: 'out_of_range',
    });
    expect(value('currency', '99.99', { precision: 4, scale: 2 })).toEqual({
      ok: true,
      value: '99.99',
    });
  });

  it('accepts real calendar dates and instants with an offset', () => {
    expect(value('date', '2026-02-28')).toEqual({ ok: true, value: '2026-02-28' });
    expect(value('date', '2026-02-30')).toEqual({ ok: false, code: 'invalid_format' });
    expect(value('date', '28/02/2026')).toEqual({ ok: false, code: 'invalid_format' });
    expect(value('datetime', '2026-09-27T10:00:00+03:00')).toEqual({
      ok: true,
      value: '2026-09-27T07:00:00.000Z',
    });
    expect(value('datetime', '2026-09-27T10:00:00')).toEqual({ ok: false, code: 'invalid_format' });
    expect(value('time', '09:30')).toEqual({ ok: true, value: '09:30:00' });
    expect(value('time', '24:00')).toEqual({ ok: false, code: 'invalid_format' });
  });

  it('checks emails, phones and URLs', () => {
    expect(value('email', ' maya@pixelcraft.example ')).toEqual({
      ok: true,
      value: 'maya@pixelcraft.example',
    });
    expect(value('email', 'not-an-email')).toEqual({ ok: false, code: 'invalid_format' });
    expect(value('phone', '+974 5555 0100')).toEqual({ ok: true, value: '+974 5555 0100' });
    expect(value('phone', '12')).toEqual({ ok: false, code: 'invalid_format' });
    expect(value('phone', 'call me')).toEqual({ ok: false, code: 'invalid_format' });
    expect(value('url', 'pixelcraft.example')).toEqual({
      ok: true,
      value: 'https://pixelcraft.example',
    });
    expect(value('url', 'ftp://files.example')).toEqual({ ok: false, code: 'invalid_format' });
    expect(value('url', 'localhost')).toEqual({ ok: false, code: 'invalid_format' });
    expect(value('url', 'http://')).toEqual({ ok: false, code: 'invalid_format' });
  });

  it('limits picklists to active (or record-type) values', () => {
    const f = field('picklist', { picklistValues: pick('hot', 'cold', 'retired') });
    expect(normaliseValue(f, 'hot')).toEqual({ ok: true, value: 'hot' });
    expect(normaliseValue(f, 'retired')).toEqual({ ok: false, code: 'not_in_picklist' });
    expect(normaliseValue(f, 'hot', ['cold'])).toEqual({ ok: false, code: 'not_in_picklist' });
    const multi = field('multi_picklist', { picklistValues: pick('a', 'b') });
    expect(normaliseValue(multi, ['a', 'b', 'a'])).toEqual({ ok: true, value: ['a', 'b'] });
    expect(normaliseValue(multi, [])).toEqual({ ok: true, value: null });
    expect(normaliseValue(multi, ['c'])).toEqual({ ok: false, code: 'not_in_picklist' });
    expect(normaliseValue(multi, 'a')).toEqual({ ok: false, code: 'invalid_type' });
  });

  it('checks references, booleans and coordinates', () => {
    const id = '01920000-0000-7000-8000-00000000000A';
    expect(value('lookup', id)).toEqual({ ok: true, value: id.toLowerCase() });
    expect(value('user', 'someone')).toEqual({ ok: false, code: 'invalid_format' });
    expect(value('checkbox', true)).toEqual({ ok: true, value: true });
    expect(value('geolocation', { lat: 25.3, lng: 51.5 })).toMatchObject({ ok: true });
    expect(value('geolocation', { lat: 95, lng: 0 })).toEqual({ ok: false, code: 'out_of_range' });
    expect(value('geolocation', 'Doha')).toEqual({ ok: false, code: 'invalid_type' });
  });

  it('knows which types sort', () => {
    expect(isSortable('text')).toBe(true);
    expect(isSortable('long_text')).toBe(false);
    expect(isSortable('multi_picklist')).toBe(false);
  });
});

function object(apiName: string, extra: Partial<ObjectMeta> = {}): ObjectMeta {
  return {
    id: `${apiName}-id`,
    apiName,
    table: apiName,
    isStandard: true,
    label: { singular: null, plural: null },
    labelKey: null,
    icon: 'x',
    color: 'jade',
    recordNumberPrefix: 'X',
    nameField: apiName === 'account' ? 'name' : 'last_name',
    features: {},
    fields: [
      field('picklist', {
        apiName: 'rating',
        picklistValues: pick('hot', 'warm', 'cold', 'retired'),
      }),
    ],
    recordTypes: [
      {
        id: 'rt-master',
        apiName: 'master',
        name: 'Master',
        active: true,
        isDefault: true,
        pipelineId: null,
        picklistValues: {},
      },
      {
        id: 'rt-retail',
        apiName: 'retail',
        name: 'Retail',
        active: true,
        isDefault: false,
        pipelineId: null,
        picklistValues: { rating: ['warm'] },
      },
    ],
    layouts: [
      {
        id: 'l-default',
        name: 'Default',
        isDefault: true,
        sections: [],
        relatedLists: [],
        actions: [],
      },
      {
        id: 'l-sales',
        name: 'Sales',
        isDefault: false,
        sections: [],
        relatedLists: [],
        actions: [],
      },
    ],
    layoutAssignments: [{ profileId: 'p-sales', recordTypeId: 'rt-retail', layoutId: 'l-sales' }],
    compactFields: [],
    validationRules: [],
    paths: [],
    autoNumbers: [],
    ...extra,
  };
}
const tenant = (version: number): TenantMetadata => ({
  tenantId: 't',
  version,
  objects: [object('lead'), object('account')],
});

describe('MetadataIndex', () => {
  const index = new MetadataIndex(tenant(3));

  it('finds objects and fields and names people by first and last name', () => {
    expect(index.version).toBe(3);
    expect(index.object('lead')?.id).toBe('lead-id');
    expect(index.object('nope')).toBeUndefined();
    expect(index.field('lead', 'rating')?.type).toBe('picklist');
    expect(index.field('nope', 'rating')).toBeUndefined();
    expect(index.nameFields('lead')).toEqual(['first_name', 'last_name']);
    expect(index.nameFields('account')).toEqual(['name']);
    expect(index.nameFields('nope')).toEqual([]);
  });

  it('picks the assigned layout, else the default', () => {
    expect(index.layoutFor('lead', 'p-sales', 'rt-retail')?.id).toBe('l-sales');
    expect(index.layoutFor('lead', 'p-other', 'rt-retail')?.id).toBe('l-default');
    expect(index.layoutFor('nope', null, null)).toBeUndefined();
    expect(index.defaultRecordType('lead')?.apiName).toBe('master');
  });

  it('offers the record type’s active values', () => {
    expect(index.picklistValues('lead', 'rating', 'rt-master').map((v) => v.apiValue)).toEqual([
      'hot',
      'warm',
      'cold',
    ]);
    expect(index.picklistValues('lead', 'rating', 'rt-retail').map((v) => v.apiValue)).toEqual([
      'warm',
    ]);
    expect(index.picklistValues('lead', 'nope', null)).toEqual([]);
  });
});

describe('MetadataCache', () => {
  function memoryStore() {
    const data = new Map<string, string>();
    return {
      data,
      get: (key: string) => Promise.resolve(data.get(key) ?? null),
      set: (key: string, v: string) => {
        data.set(key, v);
        return Promise.resolve('OK');
      },
    };
  }

  it('loads once per version and shares through the store', async () => {
    const store = memoryStore();
    let loads = 0;
    const load = (v: number) => () => {
      loads += 1;
      return Promise.resolve(tenant(v));
    };
    const a = new MetadataCache(store);
    expect((await a.getOrLoad('t', 1, load(1))).version).toBe(1);
    await a.getOrLoad('t', 1, load(1));
    expect(loads).toBe(1);
    expect(store.data.has(MetadataCache.key('t', 1))).toBe(true);
    // Another process finds it in Valkey.
    const b = new MetadataCache(store);
    await b.getOrLoad('t', 1, load(1));
    expect(loads).toBe(1);
    // A new version is a new entry.
    expect((await a.getOrLoad('t', 2, load(2))).version).toBe(2);
    expect(loads).toBe(2);
  });

  it('evicts the least recently used entry and survives a store failure', async () => {
    const errors: unknown[] = [];
    const broken = {
      get: () => Promise.reject(new Error('down')),
      set: () => Promise.reject(new Error('down')),
    };
    const cache = new MetadataCache(broken, { maxEntries: 2, onError: (e) => errors.push(e) });
    let loads = 0;
    const load = () => {
      loads += 1;
      return Promise.resolve(tenant(1));
    };
    await cache.getOrLoad('a', 1, load);
    await cache.getOrLoad('b', 1, load);
    await cache.getOrLoad('a', 1, load); // a is now most recent
    await cache.getOrLoad('c', 1, load); // evicts b
    await cache.getOrLoad('a', 1, load);
    expect(loads).toBe(3);
    await cache.getOrLoad('b', 1, load);
    expect(loads).toBe(4);
    expect(errors.length).toBeGreaterThan(0);
    // Without a store it is in-process only.
    const local = new MetadataCache(null);
    await local.getOrLoad('a', 1, load);
    expect(loads).toBe(5);
  });
});
