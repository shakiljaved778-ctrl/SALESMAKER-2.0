import type { FieldType } from './types.js';

/**
 * A tenant's metadata as the engines use it (P02 T02): what `loadTenantMetadata` (@sm/db) reads
 * from the metadata tables, cached per tenant under `metadataVersion`. Plain JSON, so it can live
 * in Valkey; `MetadataIndex` adds the lookups.
 */
export interface PicklistValueMeta {
  apiValue: string;
  /** Admin label, or null to use `labelKey`. */
  label: string | null;
  labelKey: string | null;
  category: string | null;
  active: boolean;
  isDefault: boolean;
}

/** Where a field's value lives: a typed column (standard fields) or a key of `custom` jsonb. */
export type FieldStorage = { kind: 'column'; column: string } | { kind: 'custom'; key: string };

export interface FieldMeta {
  id: string;
  apiName: string;
  type: FieldType;
  isStandard: boolean;
  label: string | null;
  labelKey: string | null;
  description: string | null;
  helpText: string | null;
  required: boolean;
  system: boolean;
  unique: boolean;
  externalId: boolean;
  searchable: boolean;
  indexed: boolean;
  trackHistory: boolean;
  length: number | null;
  precision: number | null;
  scale: number | null;
  referenceTo: string[];
  relationshipName: string | null;
  defaultValue: unknown;
  formula: string | null;
  formulaReturnType: FieldType | null;
  picklistValues: PicklistValueMeta[];
  storage: FieldStorage;
}

export interface RecordTypeMeta {
  id: string;
  apiName: string;
  name: string;
  active: boolean;
  isDefault: boolean;
  pipelineId: string | null;
  /** Field API name → the picklist values this record type offers (absent: all of them). */
  picklistValues: Record<string, string[]>;
}

export interface LayoutMeta {
  id: string;
  name: string;
  isDefault: boolean;
  sections: unknown;
  relatedLists: unknown;
  actions: unknown;
}

export interface ValidationRuleMeta {
  id: string;
  apiName: string;
  formula: string;
  errorMessage: string;
  errorField: string | null;
  active: boolean;
}

export interface ObjectMeta {
  id: string;
  apiName: string;
  /** The physical table (standard objects: the API name). */
  table: string;
  isStandard: boolean;
  label: { singular: string | null; plural: string | null };
  labelKey: { singular: string; plural: string } | null;
  icon: string;
  color: string;
  recordNumberPrefix: string;
  nameField: string;
  features: Record<string, boolean>;
  fields: FieldMeta[];
  recordTypes: RecordTypeMeta[];
  layouts: LayoutMeta[];
  /** Profile × record type overrides of the default layout. */
  layoutAssignments: { profileId: string; recordTypeId: string; layoutId: string }[];
  compactFields: string[];
  validationRules: ValidationRuleMeta[];
  /** Record type id → picklist field → per-value path guidance. */
  paths: { recordTypeId: string; field: string; active: boolean; steps: unknown }[];
  autoNumbers: { field: string; fieldId: string; format: string }[];
}

export interface TenantMetadata {
  tenantId: string;
  version: number;
  objects: ObjectMeta[];
}

/** Objects whose display name joins first and last name (§4.2 people objects). */
const PERSON_NAME: Record<string, readonly string[]> = {
  lead: ['first_name', 'last_name'],
  contact: ['first_name', 'last_name'],
};

/** Lookups over a TenantMetadata (built once per cached copy). */
export class MetadataIndex {
  private readonly objects = new Map<string, ObjectMeta>();
  private readonly fields = new Map<string, Map<string, FieldMeta>>();

  constructor(readonly metadata: TenantMetadata) {
    for (const o of metadata.objects) {
      this.objects.set(o.apiName, o);
      this.fields.set(o.apiName, new Map(o.fields.map((f) => [f.apiName, f])));
    }
  }

  get version(): number {
    return this.metadata.version;
  }

  object(apiName: string): ObjectMeta | undefined {
    return this.objects.get(apiName);
  }

  field(object: string, field: string): FieldMeta | undefined {
    return this.fields.get(object)?.get(field);
  }

  /** The fields whose values make up a record's display name, in order. */
  nameFields(object: string): readonly string[] {
    const o = this.objects.get(object);
    if (!o) return [];
    return PERSON_NAME[object] ?? [o.nameField];
  }

  /** The layout a profile sees for a record type: its assignment, else the default. */
  layoutFor(
    object: string,
    profileId: string | null,
    recordTypeId: string | null,
  ): LayoutMeta | undefined {
    const o = this.objects.get(object);
    if (!o) return undefined;
    const assigned = o.layoutAssignments.find(
      (a) => a.profileId === profileId && a.recordTypeId === recordTypeId,
    );
    return (
      (assigned && o.layouts.find((l) => l.id === assigned.layoutId)) ??
      o.layouts.find((l) => l.isDefault)
    );
  }

  /** The active picklist values a record of this record type may take for a field. */
  picklistValues(object: string, field: string, recordTypeId: string | null): PicklistValueMeta[] {
    const meta = this.field(object, field);
    if (!meta) return [];
    const active = meta.picklistValues.filter((v) => v.active);
    const rt = this.objects.get(object)?.recordTypes.find((r) => r.id === recordTypeId);
    const allowed = rt?.picklistValues[field];
    return allowed ? active.filter((v) => allowed.includes(v.apiValue)) : active;
  }

  defaultRecordType(object: string): RecordTypeMeta | undefined {
    return this.objects.get(object)?.recordTypes.find((r) => r.isDefault);
  }
}
