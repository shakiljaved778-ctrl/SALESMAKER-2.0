import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COMPACT_FIELDS,
  DEFAULT_SEARCHABLE,
  defaultLayoutSections,
  defaultPicklistValues,
  METADATA_OBJECTS,
  picklistLabelKeys,
  standardField,
  standardObject,
} from '../src/index.js';

describe('standard metadata defaults', () => {
  it('gives system picklists their categories and a default', () => {
    const status = defaultPicklistValues('lead', 'status');
    expect(status.map((v) => v.category)).toEqual([
      'OPEN',
      'WORKING',
      'NURTURE',
      'QUALIFIED',
      'UNQUALIFIED',
      'CONVERTED',
    ]);
    expect(status.filter((v) => v.isDefault).map((v) => v.apiValue)).toEqual(['open']);
    expect(defaultPicklistValues('opportunity', 'forecast_category')[0]).toMatchObject({
      apiValue: 'pipeline',
      category: 'PIPELINE',
      isDefault: true,
    });
    const industry = defaultPicklistValues('account', 'industry');
    expect(industry.every((v) => v.category === undefined && !v.isDefault)).toBe(true);
    expect(industry[7]).toMatchObject({
      apiValue: 'real_estate',
      labelKey: 'picklists.industry.realEstate',
    });
  });

  it('starts other picklists empty and stores lower snake_case values', () => {
    expect(defaultPicklistValues('opportunity', 'competitors')).toEqual([]);
    expect(defaultPicklistValues('product', 'family')).toEqual([]);
    expect(picklistLabelKeys().length).toBeGreaterThan(50);
    for (const object of METADATA_OBJECTS)
      for (const field of standardObject(object)?.fields ?? [])
        for (const v of defaultPicklistValues(object, field.apiName))
          expect(v.apiValue).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('names only real fields in compact layouts and search defaults', () => {
    for (const object of METADATA_OBJECTS) {
      const compact = DEFAULT_COMPACT_FIELDS[object] ?? [];
      expect(compact.length).toBeGreaterThan(0);
      expect(compact.length).toBeLessThanOrEqual(7);
      for (const field of [...compact, ...(DEFAULT_SEARCHABLE[object] ?? [])])
        expect(standardField(object, field), `${object}.${field}`).toBeDefined();
    }
  });

  it('lays out details, address, description and system information', () => {
    const lead = standardObject('lead');
    const sections = defaultLayoutSections(lead?.fields ?? []);
    expect(sections.map((s) => [s.key, s.columns, s.labelKey])).toEqual([
      ['details', 2, 'layouts.sections.details'],
      ['address', 2, 'layouts.sections.address'],
      ['description', 1, 'layouts.sections.description'],
      ['system', 2, 'layouts.sections.system'],
    ]);
    const names = sections.flatMap((s) => s.fields.map((f) => f.field));
    expect(names).not.toContain('id');
    expect(names).not.toContain('external_id');
    expect(new Set(names).size).toBe(names.length);
    // Objects without addresses or long text get only the sections they need.
    expect(
      defaultLayoutSections([
        { apiName: 'name', type: 'text', system: false },
        { apiName: 'created_at', type: 'datetime', system: true },
      ]).map((s) => s.key),
    ).toEqual(['details', 'system']);
  });
});
