import {
  MetadataIndex,
  standardObject,
  type FieldMeta,
  type FieldType,
  type ObjectMeta,
  type StandardObjectApiName,
} from '@sm/metadata';

/** Metadata for tests, straight from the catalogue (what the sync would write), plus extras. */
export function catalogueMetadata(
  objects: StandardObjectApiName[],
  custom: Partial<
    Record<StandardObjectApiName, { apiName: string; type: FieldType; required?: boolean }[]>
  > = {},
): MetadataIndex {
  const meta = (object: StandardObjectApiName): ObjectMeta => {
    const def = standardObject(object);
    if (!def) throw new Error(object);
    const field = (
      f: {
        apiName: string;
        type: FieldType;
        system?: boolean;
        required?: boolean;
        references?: readonly string[];
      },
      isStandard: boolean,
    ): FieldMeta => ({
      id: `${object}.${f.apiName}`,
      apiName: f.apiName,
      type: f.type,
      isStandard,
      label: null,
      labelKey: null,
      description: null,
      helpText: null,
      required: f.required ?? false,
      system: f.system ?? false,
      unique: false,
      externalId: false,
      searchable: false,
      indexed: false,
      trackHistory: false,
      length: null,
      precision: null,
      scale: null,
      referenceTo: [...(f.references ?? [])],
      relationshipName: null,
      defaultValue: null,
      formula: null,
      formulaReturnType: null,
      picklistValues: [],
      storage: isStandard
        ? { kind: 'column', column: f.apiName }
        : { kind: 'custom', key: f.apiName },
    });
    return {
      id: object,
      apiName: object,
      table: object,
      isStandard: true,
      label: { singular: null, plural: null },
      labelKey: def.labelKey,
      icon: def.icon,
      color: def.color,
      recordNumberPrefix: def.recordNumberPrefix,
      nameField: def.nameField,
      features: {},
      fields: [
        ...def.fields.map((f) => field(f, true)),
        ...(custom[object] ?? []).map((f) => field(f, false)),
      ],
      recordTypes: [],
      layouts: [],
      layoutAssignments: [],
      compactFields: [],
      validationRules: [],
      paths: [],
      autoNumbers: [],
    };
  };
  return new MetadataIndex({ tenantId: 't', version: 1, objects: objects.map(meta) });
}
