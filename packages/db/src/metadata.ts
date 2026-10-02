import {
  defaultPicklistValues,
  isStandardObject,
  standardField,
  standardObject,
  type FieldMeta,
  type ObjectMeta,
  type TenantMetadata,
} from '@sm/metadata';

import type { TenantTransaction } from './tenant.js';

/**
 * Read a tenant's metadata from the metadata tables (P02 T02) in one pass. The caller caches the
 * result under `version` (the tenant's `metadata_version`, read in the same transaction).
 * Deleted fields and objects are left out.
 */
export async function loadTenantMetadata(
  tx: TenantTransaction,
  version: number,
): Promise<TenantMetadata> {
  const { prisma } = tx;
  // One connection per transaction: its queries run one after another (pg refuses overlapping ones).
  const objects = await prisma.objectDefinition.findMany({ where: { deletedAt: null } });
  const fields = await prisma.fieldDefinition.findMany({
    where: { deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { apiName: 'asc' }],
  });
  const values = await prisma.picklistValue.findMany({
    orderBy: [{ sortOrder: 'asc' }, { apiValue: 'asc' }],
  });
  const recordTypes = await prisma.recordType.findMany({ orderBy: { apiName: 'asc' } });
  const rtValues = await prisma.recordTypePicklist.findMany({ include: { picklistValue: true } });
  const layouts = await prisma.pageLayout.findMany({ orderBy: { name: 'asc' } });
  const assignments = await prisma.layoutAssignment.findMany();
  const compacts = await prisma.compactLayout.findMany({ where: { isDefault: true } });
  const rules = await prisma.validationRule.findMany({ orderBy: { apiName: 'asc' } });
  const paths = await prisma.pathSetting.findMany();
  const autos = await prisma.autoNumberSequence.findMany();

  const fieldById = new Map(fields.map((f) => [f.id, f]));
  const valuesByField = groupBy(values, (v) => v.fieldId);
  const byObject = <T extends { objectId: string }>(rows: T[]) => groupBy(rows, (r) => r.objectId);
  const fieldsOf = byObject(fields);
  const rtsOf = byObject(recordTypes);
  const layoutsOf = byObject(layouts);
  const assignmentsOf = byObject(assignments);
  const rulesOf = byObject(rules);
  const compactOf = new Map(compacts.map((c) => [c.objectId, c.fields]));
  const rtValuesOf = groupBy(rtValues, (r) => r.recordTypeId);
  const rtObject = new Map(recordTypes.map((r) => [r.id, r.objectId]));

  const toField = (objectApiName: string, f: (typeof fields)[number]): FieldMeta => ({
    id: f.id,
    apiName: f.apiName,
    type: f.type,
    isStandard: f.isStandard,
    label: f.label,
    labelKey: f.isStandard ? (standardField(objectApiName, f.apiName)?.labelKey ?? null) : null,
    description: f.description,
    helpText: f.helpText,
    required: f.required,
    system: f.system,
    unique: f.isUnique,
    externalId: f.isExternalId,
    searchable: f.searchable,
    indexed: f.indexed,
    trackHistory: f.trackHistory,
    length: f.length,
    precision: f.precision,
    scale: f.scale,
    referenceTo: f.referenceTo,
    relationshipName: f.relationshipName,
    defaultValue: f.defaultValue ?? null,
    formula: f.formula,
    formulaReturnType: f.formulaReturnType,
    picklistValues: (valuesByField.get(f.id) ?? []).map((v) => ({
      apiValue: v.apiValue,
      label: v.label,
      labelKey: f.isStandard ? picklistKey(objectApiName, f.apiName, v.apiValue) : null,
      category: v.category,
      active: v.active,
      isDefault: v.isDefault,
    })),
    storage: f.isStandard
      ? { kind: 'column', column: f.apiName }
      : { kind: 'custom', key: f.apiName },
  });

  return {
    tenantId: tx.context.tenantId,
    version,
    objects: objects.map((o): ObjectMeta => {
      const std = o.isStandard ? standardObject(o.apiName) : undefined;
      return {
        id: o.id,
        apiName: o.apiName,
        table: o.apiName,
        isStandard: o.isStandard,
        label: { singular: o.labelSingular, plural: o.labelPlural },
        labelKey: std ? std.labelKey : null,
        icon: o.icon,
        color: o.color,
        recordNumberPrefix: o.recordNumberPrefix,
        nameField: o.nameField,
        features: o.features as Record<string, boolean>,
        fields: (fieldsOf.get(o.id) ?? []).map((f) => toField(o.apiName, f)),
        recordTypes: (rtsOf.get(o.id) ?? []).map((r) => {
          const picklistValues: Record<string, string[]> = {};
          for (const row of rtValuesOf.get(r.id) ?? []) {
            const field = fieldById.get(row.picklistValue.fieldId);
            if (field) (picklistValues[field.apiName] ??= []).push(row.picklistValue.apiValue);
          }
          return {
            id: r.id,
            apiName: r.apiName,
            name: r.name,
            active: r.active,
            isDefault: r.isDefault,
            pipelineId: r.pipelineId,
            picklistValues,
          };
        }),
        layouts: (layoutsOf.get(o.id) ?? []).map((l) => ({
          id: l.id,
          name: l.name,
          isDefault: l.isDefault,
          sections: l.sections,
          relatedLists: l.relatedLists,
          actions: l.actions,
        })),
        layoutAssignments: (assignmentsOf.get(o.id) ?? []).map((a) => ({
          profileId: a.profileId,
          recordTypeId: a.recordTypeId,
          layoutId: a.pageLayoutId,
        })),
        compactFields: compactOf.get(o.id) ?? [o.nameField],
        validationRules: (rulesOf.get(o.id) ?? []).map((r) => ({
          id: r.id,
          apiName: r.apiName,
          formula: r.formula,
          errorMessage: r.errorMessage,
          errorField: r.errorField,
          active: r.active,
        })),
        paths: paths
          .filter((p) => rtObject.get(p.recordTypeId) === o.id)
          .flatMap((p) => {
            const field = fieldById.get(p.fieldId);
            return field
              ? [
                  {
                    recordTypeId: p.recordTypeId,
                    field: field.apiName,
                    active: p.active,
                    steps: p.steps,
                  },
                ]
              : [];
          }),
        autoNumbers: autos.flatMap((a) => {
          const field = fieldById.get(a.fieldId);
          return field && field.objectId === o.id
            ? [{ field: field.apiName, fieldId: a.fieldId, format: a.format }]
            : [];
        }),
      };
    }),
  };
}

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/** Label key of a catalogue value on a standard picklist; admin-added values have none. */
function picklistKey(object: string, field: string, value: string): string | null {
  if (!isStandardObject(object)) return null;
  return defaultPicklistValues(object, field).find((v) => v.apiValue === value)?.labelKey ?? null;
}
