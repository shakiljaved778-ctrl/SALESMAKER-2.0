/** Field types (§5.3). Standard fields use a subset; custom fields (P02) may use any. */
export const FIELD_TYPES = [
  'id',
  'text',
  'textarea',
  'long_text',
  'rich_text',
  'email',
  'phone',
  'url',
  'number',
  'currency',
  'percent',
  'date',
  'datetime',
  'time',
  'checkbox',
  'picklist',
  'multi_picklist',
  'lookup',
  'master_detail',
  'auto_number',
  'formula',
  'rollup_summary',
  'geolocation',
  'user',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Org-wide default sharing models (§6.3). */
export const SHARING_MODELS = [
  'PRIVATE',
  'PUBLIC_READ',
  'PUBLIC_READ_WRITE',
  'CONTROLLED_BY_PARENT',
] as const;
export type SharingModel = (typeof SHARING_MODELS)[number];

/** Categorical colour chip for an object icon (§9.2, §9.9). Iris is never used: it means AI. */
export type ObjectColor =
  'jade' | 'cobalt' | 'rose' | 'amber' | 'olive' | 'cyan' | 'clay' | 'graphite';

export type StandardObjectApiName =
  | 'lead'
  | 'account'
  | 'contact'
  | 'opportunity'
  | 'campaign'
  | 'product'
  | 'quote'
  | 'contract'
  | 'order'
  | 'activity';

/** What a lookup can point at: a standard object, or a platform table that is not a CRM object. */
export type ReferenceTarget = StandardObjectApiName | 'user' | 'queue' | 'pipeline' | 'record_type';

export interface StandardField {
  /** snake_case, equal to the column name on the object's table. */
  readonly apiName: string;
  readonly type: FieldType;
  /** i18n key of the field label (golden rule 5). */
  readonly labelKey: string;
  /**
   * Maintained by the platform (ids, audit stamps, conversion links, roll-ups). Always readable
   * by anyone who can read the record, never editable, and outside field-level security.
   */
  readonly system: boolean;
  /** Required on create. A required field cannot be hidden or made read-only by FLS (§6.2). */
  readonly required: boolean;
  /** Lookup / master-detail / user targets. */
  readonly references?: readonly ReferenceTarget[];
  /** System value set for picklists whose values carry meaning (categories, types). */
  readonly values?: readonly string[];
}

export interface StandardObject {
  readonly apiName: StandardObjectApiName;
  readonly labelKey: { readonly singular: string; readonly plural: string };
  /** Lucide icon name (§9.9). */
  readonly icon: string;
  readonly color: ObjectColor;
  /** Auto-number prefix of `record_number` (§4.1), e.g. `L` → `L-000123`. */
  readonly recordNumberPrefix: string;
  /** The field shown as the record's name. */
  readonly nameField: string;
  readonly sharing: {
    readonly default: SharingModel;
    readonly allowed: readonly SharingModel[];
    /** Fields whose parent record controls access when the model is CONTROLLED_BY_PARENT. */
    readonly parentFields: readonly string[];
    /** "Grant access using hierarchies" (§6.3). Always on for standard objects. */
    readonly hierarchyAccess: true;
  };
  readonly features: {
    readonly activities: boolean;
    readonly history: boolean;
    readonly search: boolean;
    readonly reports: boolean;
    readonly api: boolean;
  };
  readonly fields: readonly StandardField[];
}
