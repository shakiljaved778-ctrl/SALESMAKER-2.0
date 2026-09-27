import type { FieldMeta, FieldType, MetadataIndex } from '@sm/metadata';

import type { CheckEnvironment, FieldInfo, FieldLookup, FormulaType } from './types.js';

/** How a stored field type reads in formulas (§5.3 → §5.5). */
export function formulaTypeOf(type: FieldType, returnType?: FieldType | null): FormulaType {
  switch (type) {
    case 'number':
    case 'rollup_summary':
      return 'Number';
    case 'currency':
      return 'Currency';
    case 'percent':
      return 'Percent';
    case 'checkbox':
      return 'Boolean';
    case 'date':
      return 'Date';
    case 'datetime':
      return 'DateTime';
    case 'time':
      return 'Time';
    case 'picklist':
      return 'Picklist';
    case 'multi_picklist':
      return 'MultiPicklist';
    case 'formula':
      return returnType ? formulaTypeOf(returnType) : 'Text';
    default:
      return 'Text';
  }
}

/**
 * The relationship name a lookup is followed by in paths: `account_id` → `account`,
 * `owner_id` → `owner`, `region__c` → `region__r` (unless the field sets its own).
 */
export function relationshipName(field: Pick<FieldMeta, 'apiName' | 'relationshipName'>): string {
  if (field.relationshipName) return field.relationshipName;
  if (field.apiName.endsWith('__c')) return `${field.apiName.slice(0, -3)}__r`;
  return field.apiName.replace(/_id$/, '');
}

/** Fields of platform records a path may end on (users behind owner/created_by, record types…). */
const PLATFORM: Record<string, Record<string, FormulaType>> = {
  user: {
    id: 'Text',
    name: 'Text',
    email: 'Text',
    title: 'Text',
    department: 'Text',
    phone: 'Text',
  },
  queue: { id: 'Text', name: 'Text', email: 'Text' },
  record_type: { id: 'Text', name: 'Text', api_name: 'Text' },
  pipeline: { id: 'Text', name: 'Text' },
};

/** `$User.*` and `$Org.*` (§5.5). */
const GLOBALS: Record<'User' | 'Org', Record<string, FormulaType>> = {
  User: {
    id: 'Text',
    name: 'Text',
    email: 'Text',
    title: 'Text',
    department: 'Text',
    locale: 'Text',
    timezone: 'Text',
    profile: 'Text',
  },
  Org: { id: 'Text', name: 'Text', corporate_currency: 'Text', default_timezone: 'Text' },
};

const LOOKUPS: ReadonlySet<FieldType> = new Set(['lookup', 'master_detail', 'user']);

/** A checker environment over a tenant's metadata, rooted at one object. */
export function metadataEnvironment(
  metadata: MetadataIndex,
  object: string,
  options: { allowPriorValues: boolean },
): CheckEnvironment {
  const info = (f: FieldMeta): FieldInfo => ({
    type: formulaTypeOf(f.type, f.formulaReturnType),
    ...(f.picklistValues.length ? { picklistValues: f.picklistValues.map((v) => v.apiValue) } : {}),
  });
  return {
    allowPriorValues: options.allowPriorValues,
    global: (scope, name) => {
      const type = GLOBALS[scope][name];
      return type ? { type } : null;
    },
    field(path): FieldLookup {
      let current = object;
      for (let i = 0; i < path.length; i += 1) {
        const segment = path[i] ?? '';
        const last = i === path.length - 1;
        const platform = PLATFORM[current];
        if (platform) {
          const type = last ? platform[segment] : undefined;
          return type ? { type } : { error: last ? 'unknown_field' : 'not_a_relationship' };
        }
        const obj = metadata.object(current);
        if (!obj) return { error: 'unknown_field' };
        if (last) {
          const f = metadata.field(current, segment);
          return f ? info(f) : { error: 'unknown_field' };
        }
        const lookup = obj.fields.find(
          (f) => LOOKUPS.has(f.type) && relationshipName(f) === segment,
        );
        if (!lookup)
          return {
            error: metadata.field(current, segment) ? 'not_a_relationship' : 'unknown_field',
          };
        // Polymorphic lookups (owner: user or queue) are followed as their first target.
        current = lookup.referenceTo[0] ?? (lookup.type === 'user' ? 'user' : '');
      }
      return { error: 'unknown_field' };
    },
  };
}
