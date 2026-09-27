import { MetadataIndex, type FieldMeta, type FieldType, type ObjectMeta } from '@sm/metadata';
import { describe, expect, it } from 'vitest';

import {
  checkFormula,
  formulaTypeOf,
  metadataEnvironment,
  relationshipName,
} from '../src/index.js';

function field(apiName: string, type: FieldType, extra: Partial<FieldMeta> = {}): FieldMeta {
  return {
    id: apiName,
    apiName,
    type,
    isStandard: !apiName.endsWith('__c'),
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
    storage: { kind: 'column', column: apiName },
    ...extra,
  };
}

function object(apiName: string, fields: FieldMeta[]): ObjectMeta {
  return {
    id: apiName,
    apiName,
    table: apiName,
    isStandard: true,
    label: { singular: null, plural: null },
    labelKey: null,
    icon: 'x',
    color: 'jade',
    recordNumberPrefix: 'X',
    nameField: 'name',
    features: {},
    fields,
    recordTypes: [],
    layouts: [],
    layoutAssignments: [],
    compactFields: [],
    validationRules: [],
    paths: [],
    autoNumbers: [],
  };
}

const metadata = new MetadataIndex({
  tenantId: 't',
  version: 1,
  objects: [
    object('opportunity', [
      field('name', 'text'),
      field('amount', 'currency'),
      field('stage', 'picklist', {
        picklistValues: [
          {
            apiValue: 'won',
            label: null,
            labelKey: null,
            category: null,
            active: true,
            isDefault: false,
          },
        ],
      }),
      field('account_id', 'lookup', { referenceTo: ['account'] }),
      field('owner_id', 'lookup', { referenceTo: ['user', 'queue'] }),
      field('record_type_id', 'lookup', { referenceTo: ['record_type'] }),
      field('partner__c', 'lookup', { referenceTo: ['account'] }),
      field('sponsor__c', 'lookup', { referenceTo: ['contact'], relationshipName: 'champion__r' }),
      field('margin__c', 'formula', { formulaReturnType: 'percent' }),
      field('created_by', 'user', { referenceTo: ['user'] }),
    ]),
    object('account', [
      field('name', 'text'),
      field('annual_revenue', 'currency'),
      field('parent_account_id', 'lookup', { referenceTo: ['account'] }),
      field('owner_id', 'lookup', { referenceTo: ['user', 'queue'] }),
    ]),
    object('contact', [field('email', 'email')]),
  ],
});
const env = (allowPriorValues = false) =>
  metadataEnvironment(metadata, 'opportunity', { allowPriorValues });
const check = (source: string) => checkFormula(source, env());

describe('metadataEnvironment', () => {
  it('maps stored field types to formula types', () => {
    expect(formulaTypeOf('currency')).toBe('Currency');
    expect(formulaTypeOf('checkbox')).toBe('Boolean');
    expect(formulaTypeOf('multi_picklist')).toBe('MultiPicklist');
    expect(formulaTypeOf('time')).toBe('Time');
    expect(formulaTypeOf('email')).toBe('Text');
    expect(formulaTypeOf('rollup_summary')).toBe('Number');
    expect(formulaTypeOf('formula', 'date')).toBe('Date');
    expect(formulaTypeOf('formula')).toBe('Text');
    for (const t of ['number', 'percent', 'date', 'datetime', 'picklist'] as const)
      expect(formulaTypeOf(t)).not.toBe('Text');
  });

  it('names relationships after their lookup', () => {
    expect(relationshipName({ apiName: 'account_id', relationshipName: null })).toBe('account');
    expect(relationshipName({ apiName: 'partner__c', relationshipName: null })).toBe('partner__r');
    expect(relationshipName({ apiName: 'sponsor__c', relationshipName: 'champion__r' })).toBe(
      'champion__r',
    );
  });

  it.each([
    ['amount * 2', 'Currency'],
    ['margin__c', 'Percent'],
    ["ISPICKVAL(stage, 'won')", 'Boolean'],
    ['account.name', 'Text'],
    ['account.parent_account.parent_account.annual_revenue', 'Currency'],
    ['account.owner.email', 'Text'],
    ['owner.name', 'Text'],
    ['created_by.email', 'Text'],
    ['record_type.api_name', 'Text'],
    ['partner__r.name', 'Text'],
    ['champion__r.email', 'Text'],
    ['$User.email', 'Text'],
    ['$Org.corporate_currency', 'Text'],
  ])('%s : %s', (source, type) => {
    const r = check(source);
    expect(r.ok && r.type).toBe(type);
  });

  it.each([
    ['nope', 'unknown_field'],
    ['account.nope', 'unknown_field'],
    ['nope.name', 'unknown_field'],
    ['name.first', 'not_a_relationship'],
    ['owner.salary', 'unknown_field'],
    ['owner.manager.name', 'not_a_relationship'],
    ['sponsor__c.email', 'not_a_relationship'],
    ['$User.salary', 'unknown_global'],
    ['ISNEW()', 'prior_not_allowed'],
  ])('%s → %s', (source, code) => {
    const r = check(source);
    expect(!r.ok && r.error.code).toBe(code);
  });

  it('allows prior values when asked, and lists picklist values', () => {
    expect(checkFormula('ISCHANGED(amount)', env(true)).ok).toBe(true);
    expect(env().field(['stage'])).toEqual({ type: 'Picklist', picklistValues: ['won'] });
    expect(env().field([])).toEqual({ error: 'unknown_field' });
    expect(metadataEnvironment(metadata, 'nope', { allowPriorValues: false }).field(['x'])).toEqual(
      {
        error: 'unknown_field',
      },
    );
  });
});
