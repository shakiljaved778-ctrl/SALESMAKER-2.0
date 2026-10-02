import { describe, expect, it } from 'vitest';

import {
  asLookup,
  cellValue,
  editorValue,
  inlineEditable,
  objectForSection,
  picklistOptions,
  recordName,
  sectionForObject,
  uiType,
  writeValue,
  type DescribedField,
  type DescribedObject,
} from '../src/components/records/fields';

const field = (over: Partial<DescribedField>): DescribedField => ({
  name: 'f',
  label: 'F',
  type: 'text',
  custom: false,
  required: false,
  readable: true,
  editable: true,
  sortable: true,
  searchable: false,
  unique: false,
  externalId: false,
  length: null,
  precision: null,
  scale: null,
  referenceTo: [],
  helpText: null,
  ...over,
});

describe('object list fields (§9.11 T1)', () => {
  it('maps sidebar sections to objects and back', () => {
    expect(objectForSection('opportunities')).toBe('opportunity');
    expect(objectForSection('pipeline')).toBeNull();
    expect(objectForSection('toString')).toBeNull();
    expect(sectionForObject('opportunity')).toBe('opportunities');
    expect(sectionForObject('user')).toBeNull();
  });

  it('renders metadata types with the matching field renderer', () => {
    expect(uiType('textarea')).toBe('long_text');
    expect(uiType('user')).toBe('lookup');
    expect(uiType('currency')).toBe('currency');
    expect(uiType('auto_number')).toBe('text');
  });

  it('edits inline only what needs no extra context and the caller may edit', () => {
    expect(inlineEditable(field({ type: 'picklist' }))).toBe(true);
    expect(inlineEditable(field({ type: 'lookup' }))).toBe(false);
    expect(inlineEditable(field({ type: 'text', editable: false }))).toBe(false);
    expect(inlineEditable(field({ type: 'auto_number' }))).toBe(false);
  });

  it('unwraps money and lookups, and writes lookups by id', () => {
    expect(cellValue({ amount: '1250.00', currency: 'QAR' })).toEqual({
      value: '1250.00',
      currencyCode: 'QAR',
    });
    expect(cellValue('x')).toEqual({ value: 'x' });
    const lookup = { id: 'a1', name: 'Aurelia Bank', object: 'account' };
    expect(asLookup(lookup)).toEqual(lookup);
    expect(asLookup('a1')).toBeNull();
    expect(editorValue(field({ type: 'lookup' }), lookup)).toEqual(lookup);
    expect(editorValue(field({ type: 'currency' }), { amount: '5.00', currency: 'USD' })).toBe(
      '5.00',
    );
    expect(editorValue(field({ type: 'number' }), 42)).toBe('42');
    expect(editorValue(field({ type: 'multi_picklist' }), ['a', 1])).toEqual(['a']);
    expect(writeValue(lookup)).toBe('a1');
    expect(writeValue(['a'])).toEqual(['a']);
    expect(writeValue(null)).toBeNull();
  });

  it('tones won categories as success and names people by first and last name', () => {
    const stage = field({
      type: 'picklist',
      picklistValues: [
        { value: 'won', label: 'Closed won', category: 'won', default: false },
        { value: 'open', label: 'Open', category: null, default: true },
      ],
    });
    expect(picklistOptions(stage).map((o) => o.tone)).toEqual(['success', 'neutral']);
    const lead = { nameFields: ['first_name', 'last_name'] } as unknown as DescribedObject;
    expect(recordName(lead, { id: 'x', version: 1, first_name: 'Amira', last_name: 'Chen' })).toBe(
      'Amira Chen',
    );
    expect(recordName(lead, { id: 'x', version: 1 })).toBe('x');
  });
});
