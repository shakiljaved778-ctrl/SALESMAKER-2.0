import type { DescribedFieldDto, DescribedObjectDto } from '@sm/contracts';
import type { FieldEditorValue, FieldType, LookupValue, PicklistValue } from '@sm/ui';
import type { z } from 'zod';

export type DescribedField = z.infer<typeof DescribedFieldDto>;
export type DescribedObject = z.infer<typeof DescribedObjectDto>;
/** A record as the records API returns it. */
export type RecordRow = Record<string, unknown> & { id: string; version: number };

/** Sidebar sections that are object homes (§9.11 T1), by URL segment. */
export const OBJECT_SECTIONS = {
  leads: 'lead',
  accounts: 'account',
  contacts: 'contact',
  opportunities: 'opportunity',
  campaigns: 'campaign',
} as const;
export type ObjectSection = keyof typeof OBJECT_SECTIONS;

export type SectionObject = (typeof OBJECT_SECTIONS)[ObjectSection];

export function objectForSection(section: string): SectionObject | null {
  return Object.hasOwn(OBJECT_SECTIONS, section) ? OBJECT_SECTIONS[section as ObjectSection] : null;
}

export function sectionForObject(object: string): string | null {
  return (
    (Object.entries(OBJECT_SECTIONS) as [ObjectSection, string][]).find(
      ([, name]) => name === object,
    )?.[0] ?? null
  );
}

/** How a metadata field type renders and edits (§9.10 column-type formatting). */
export function uiType(type: string): FieldType {
  switch (type) {
    case 'textarea':
    case 'long_text':
    case 'rich_text':
      return 'long_text';
    case 'lookup':
    case 'master_detail':
    case 'user':
      return 'lookup';
    case 'number':
    case 'percent':
    case 'currency':
    case 'date':
    case 'datetime':
    case 'picklist':
    case 'multi_picklist':
    case 'phone':
    case 'email':
    case 'url':
    case 'checkbox':
      return type;
    default:
      return 'text';
  }
}

/** Types whose inline editor needs nothing beyond the field itself. */
const INLINE = new Set<FieldType>([
  'text',
  'long_text',
  'number',
  'percent',
  'currency',
  'date',
  'datetime',
  'picklist',
  'multi_picklist',
  'phone',
  'email',
  'url',
  'checkbox',
]);

export function inlineEditable(field: DescribedField): boolean {
  const kind = uiType(field.type);
  return field.editable && INLINE.has(kind) && field.type !== 'auto_number';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Money travels as `{ amount, currency }`; the field renderers take the amount and the code. */
export function cellValue(value: unknown): { value: unknown; currencyCode?: string } {
  if (
    isObject(value) &&
    typeof value['amount'] === 'string' &&
    typeof value['currency'] === 'string'
  )
    return { value: value['amount'], currencyCode: value['currency'] };
  return { value };
}

export function asLookup(value: unknown): LookupValue | null {
  return isObject(value) && typeof value['id'] === 'string' && typeof value['name'] === 'string'
    ? {
        id: value['id'],
        name: value['name'],
        object: typeof value['object'] === 'string' ? value['object'] : '',
      }
    : null;
}

/** The editor's starting value for a record's field. */
export function editorValue(field: DescribedField, value: unknown): FieldEditorValue {
  if (uiType(field.type) === 'lookup') return asLookup(value);
  const plain = cellValue(value).value;
  if (typeof plain === 'string' || typeof plain === 'boolean') return plain;
  if (typeof plain === 'number') return String(plain);
  if (Array.isArray(plain)) return plain.filter((v): v is string => typeof v === 'string');
  return null;
}

/** What the records API takes for an edited value (lookups by id). */
export function writeValue(value: FieldEditorValue): unknown {
  if (isObject(value) && !Array.isArray(value)) return (value as LookupValue).id;
  return value;
}

/** Picklist chips: a won/converted category reads as success; everything else stays neutral. */
export function picklistOptions(field: DescribedField): PicklistValue[] {
  return (field.picklistValues ?? []).map((v) => ({
    value: v.value,
    label: v.label,
    tone: v.category === 'won' || v.category === 'converted' ? 'success' : 'neutral',
  }));
}

/** The record's display name from the object's name fields. */
export function recordName(object: DescribedObject | null, row: RecordRow): string {
  const parts = (object?.nameFields ?? ['name'])
    .map((f) => row[f])
    .filter((v): v is string => typeof v === 'string' && v !== '');
  return parts.join(' ') || row.id;
}
