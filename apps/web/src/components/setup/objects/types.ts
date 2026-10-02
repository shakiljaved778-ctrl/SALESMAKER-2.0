import { CUSTOM_FIELD_TYPES } from '@sm/contracts';

/** Message keys (in `setup.objects`) for every field type an admin sees. */
export const TYPE_LABEL = {
  id: 'types.id',
  text: 'types.text',
  textarea: 'types.textarea',
  long_text: 'types.longText',
  rich_text: 'types.longText',
  email: 'types.email',
  phone: 'types.phone',
  url: 'types.url',
  number: 'types.number',
  currency: 'types.currency',
  percent: 'types.percent',
  date: 'types.date',
  datetime: 'types.datetime',
  time: 'types.time',
  checkbox: 'types.checkbox',
  picklist: 'types.picklist',
  multi_picklist: 'types.multiPicklist',
  lookup: 'types.lookup',
  master_detail: 'types.lookup',
  user: 'types.lookup',
  auto_number: 'types.autoNumber',
  formula: 'types.formula',
  rollup_summary: 'types.formula',
  geolocation: 'types.text',
} as const;

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];
export { CUSTOM_FIELD_TYPES };

/** Types whose settings include a length, digits, values or a target object. */
export const HAS_LENGTH = new Set<string>(['text', 'textarea', 'long_text']);
export const HAS_DIGITS = new Set<string>(['number', 'currency', 'percent']);
export const HAS_VALUES = new Set<string>(['picklist', 'multi_picklist']);

/** A field's display label: its own, else the translated one from describe, else its API name. */
export function fieldLabel(
  field: { apiName: string; label: string | null },
  described: ReadonlyMap<string, string>,
): string {
  return field.label ?? described.get(field.apiName) ?? field.apiName;
}

/** `Region of sale` → `region_of_sale`, as a custom field or record type API name starts. */
export function toApiName(label: string, max = 35): string {
  return label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/^(\d)/, 'f_$1')
    .slice(0, max)
    .replace(/_+$/, '');
}
