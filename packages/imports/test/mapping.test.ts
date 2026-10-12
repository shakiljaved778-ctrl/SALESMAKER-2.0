import { standardObject } from '@sm/metadata';
import { describe, expect, it } from 'vitest';

import {
  headersSignature,
  mapRow,
  normaliseDate,
  normaliseNumber,
  suggestMappings,
  withCountry,
} from '../src/index.js';

describe('values from text (§7.1)', () => {
  it('reads numbers written many ways', () => {
    expect(
      [
        '1,234.56',
        '1.234,56',
        '1 234',
        '$1,200',
        '12%',
        '-3.5',
        '1.234.567',
        '0,5',
        'abc',
        '1-2',
      ].map(normaliseNumber),
    ).toEqual(['1234.56', '1234.56', '1234', '1200', '12', '-3.5', '1234567', '0.5', null, null]);
  });

  it('reads dates in the given order, and ISO always', () => {
    expect(normaliseDate('2026-10-12')).toBe('2026-10-12');
    expect(normaliseDate('12/10/2026', 'DMY')).toBe('2026-10-12');
    expect(normaliseDate('10/12/2026', 'MDY')).toBe('2026-10-12');
    expect(normaliseDate('12.10.26', 'DMY')).toBe('2026-10-12');
    expect(normaliseDate('31/02/2026', 'DMY')).toBeNull();
    expect(normaliseDate('soon', 'DMY')).toBeNull();
  });

  it('adds a default country to phones without one', () => {
    expect(withCountry('5550 1234', '+974')).toBe('+974 5550 1234');
    expect(withCountry('05550 1234', '+974')).toBe('+974 5550 1234');
    expect(withCountry('+44 20 7946 0000', '+974')).toBe('+44 20 7946 0000');
    expect(withCountry('00974 5550', '+974')).toBe('00974 5550');
  });
});

describe('mapping rows', () => {
  const lead = {
    apiName: 'lead',
    fields: (standardObject('lead')?.fields ?? []).map((f) => ({
      apiName: f.apiName,
      type: f.type,
      picklistValues: f.apiName === 'lead_source' ? [{ apiValue: 'web', label: 'Web' }] : [],
      system: f.system,
    })),
  } as never;

  it('converts cells by field type, maps picklists, defers owners and applies defaults', () => {
    const row = mapRow(
      lead,
      [
        { column: 0, field: 'last_name' },
        { column: 1, field: 'annual_revenue' },
        { column: 2, field: 'lead_source', values: { Website: 'web' } },
        { column: 3, field: 'do_not_call' },
        { column: 4, field: 'owner_id', ownerBy: 'email' },
        { column: 5, field: 'currency_code' },
        { column: 6, field: 'phone', phoneCountry: '+974' },
        { column: 7, field: 'number_of_employees' },
      ],
      ['Haddad', '1,200.50', 'website', 'yes', 'Rep@Example.com', 'eur', '5550 1234', 'many'],
      7,
      { company: 'Default Co', last_name: 'Ignored' },
    );
    expect(row).toEqual({
      rowNumber: 7,
      input: {
        fields: {
          last_name: 'Haddad',
          annual_revenue: '1200.50',
          lead_source: 'web',
          do_not_call: true,
          phone: '+974 5550 1234',
          company: 'Default Co',
        },
        currencyCode: 'EUR',
      },
      errors: [{ field: 'number_of_employees', code: 'invalid_number' }],
      owner: { by: 'email', key: 'rep@example.com' },
    });
    expect(mapRow(lead, [{ column: 0, field: 'nope' }], ['x'], 2).errors).toEqual([
      { field: 'nope', code: 'unknown_field' },
    ]);
  });

  it('suggests mappings from names, labels and synonyms, each field once', () => {
    expect(
      suggestMappings(
        lead,
        ['E-mail', 'Surname', 'Company Name', 'Owner Email', 'Mystery', 'email'],
        {
          company: 'Company',
        },
      ),
    ).toEqual([
      { column: 0, field: 'email' },
      { column: 1, field: 'last_name' },
      { column: 2, field: 'company' },
      { column: 3, field: 'owner_id', ownerBy: 'email' },
    ]);
    expect(headersSignature(['First_Name', ' Email '])).toBe('first name|email');
  });
});
