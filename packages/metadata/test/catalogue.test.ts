import { flatten } from '@sm/i18n';
import en from '@sm/i18n/messages/en.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';

import {
  camelCase,
  defaultSharing,
  FIELD_TYPES,
  flsFields,
  isFlsControllable,
  isStandardObject,
  SHARING_MODELS,
  STANDARD_OBJECTS,
  standardField,
  standardObject,
} from '../src/index.js';

const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const labels = new Map(flatten(en));

describe('standard object catalogue (§5.1)', () => {
  it('has the ten standard objects with unique snake_case API names and prefixes', () => {
    expect(STANDARD_OBJECTS.map((o) => o.apiName)).toEqual([
      'lead',
      'account',
      'contact',
      'opportunity',
      'campaign',
      'product',
      'quote',
      'contract',
      'order',
      'activity',
    ]);
    const prefixes = STANDARD_OBJECTS.map((o) => o.recordNumberPrefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('gives each object unique, snake_case fields with known types and the §4.1 columns', () => {
    for (const o of STANDARD_OBJECTS) {
      const names = o.fields.map((f) => f.apiName);
      expect(new Set(names).size, o.apiName).toBe(names.length);
      for (const f of o.fields) {
        expect(f.apiName, `${o.apiName}.${f.apiName}`).toMatch(SNAKE);
        expect(FIELD_TYPES).toContain(f.type);
      }
      expect(names, o.apiName).toEqual(
        expect.arrayContaining(['id', 'record_number', 'owner_id', 'created_at', 'updated_at']),
      );
      expect(names, o.apiName).toContain(o.nameField);
    }
  });

  it('points every lookup at something that exists', () => {
    const platform = new Set(['user', 'queue', 'pipeline', 'record_type']);
    for (const o of STANDARD_OBJECTS) {
      for (const f of o.fields) {
        const isReference = ['lookup', 'master_detail', 'user'].includes(f.type);
        expect(Boolean(f.references?.length), `${o.apiName}.${f.apiName}`).toBe(isReference);
        for (const target of f.references ?? [])
          expect(isStandardObject(target) || platform.has(target), target).toBe(true);
      }
    }
  });

  it('has a label in the English catalogue for every object and field (golden rule 5)', () => {
    const missing: string[] = [];
    for (const o of STANDARD_OBJECTS) {
      for (const key of [
        o.labelKey.singular,
        o.labelKey.plural,
        ...o.fields.map((f) => f.labelKey),
      ])
        if (!labels.has(key)) missing.push(key);
    }
    expect(missing).toEqual([]);
  });

  it('never uses Iris for an object chip (Iris means AI, §9)', () => {
    for (const o of STANDARD_OBJECTS) expect(o.color).not.toBe('iris');
  });
});

describe('sharing defaults (§6.3)', () => {
  it('match the spec', () => {
    expect(defaultSharing()).toMatchObject({
      lead: 'PRIVATE',
      account: 'PRIVATE',
      contact: 'CONTROLLED_BY_PARENT',
      opportunity: 'PRIVATE',
      activity: 'CONTROLLED_BY_PARENT',
      campaign: 'PUBLIC_READ',
      product: 'PUBLIC_READ',
    });
  });

  it('allow CONTROLLED_BY_PARENT exactly when a parent field exists, and include the default', () => {
    for (const o of STANDARD_OBJECTS) {
      const { allowed, parentFields } = o.sharing;
      expect(allowed, o.apiName).toContain(o.sharing.default);
      for (const model of allowed) expect(SHARING_MODELS).toContain(model);
      expect(allowed.includes('CONTROLLED_BY_PARENT'), o.apiName).toBe(parentFields.length > 0);
      for (const p of parentFields) expect(standardField(o.apiName, p)?.references).toBeDefined();
      expect(o.sharing.hierarchyAccess).toBe(true);
    }
  });

  it('lets an opportunity follow its account, but keeps contacts off the public models', () => {
    expect(standardObject('opportunity')?.sharing.allowed).toContain('CONTROLLED_BY_PARENT');
    expect(standardObject('contact')?.sharing.parentFields).toEqual(['account_id']);
    expect(standardObject('activity')?.sharing.allowed).toEqual(['CONTROLLED_BY_PARENT']);
  });
});

describe('lookups and field-level security', () => {
  it('finds objects and fields by API name', () => {
    expect(isStandardObject('lead')).toBe(true);
    expect(isStandardObject('project__c')).toBe(false);
    expect(standardObject('nope')).toBeUndefined();
    expect(standardField('opportunity', 'close_date')).toMatchObject({
      type: 'date',
      required: true,
      labelKey: 'objects.opportunity.fields.closeDate',
    });
    expect(standardField('opportunity', 'nope')).toBeUndefined();
    expect(standardField('nope', 'id')).toBeUndefined();
  });

  it('keeps system and required fields out of FLS', () => {
    const fls = (field: string) => {
      const f = standardField('lead', field);
      if (!f) throw new Error(field);
      return isFlsControllable(f);
    };
    expect([fls('email'), fls('last_name'), fls('converted_at')]).toEqual([true, false, false]);
    const opportunity = flsFields('opportunity').map((f) => f.apiName);
    expect(opportunity).toContain('amount');
    expect(opportunity).not.toContain('stage');
    expect(opportunity).not.toContain('id');
    expect(flsFields('nope')).toEqual([]);
  });

  it('camelCases snake_case names for i18n keys', () => {
    expect(camelCase('converted_opportunity_id')).toBe('convertedOpportunityId');
    expect(camelCase('billing_postal_code')).toBe('billingPostalCode');
  });
});
