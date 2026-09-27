import type { TenantTransaction } from '@sm/db';
import { serverTranslator } from '@sm/i18n';
import {
  CATALOGUE_VERSION,
  DEFAULT_COMPACT_FIELDS,
  DEFAULT_PIPELINE_STAGES,
  DEFAULT_SEARCHABLE,
  defaultLayoutSections,
  defaultPicklistValues,
  METADATA_OBJECTS,
  standardObject,
  camelCase,
} from '@sm/metadata';

type Translate = (key: string, values?: Record<string, string>) => string;

/**
 * Bring a tenant's standard metadata up to the catalogue (P02 T01, §5.1): objects, fields,
 * picklist values, a Master record type, a default page and compact layout, the record-number
 * format and the system list views. Idempotent and additive: it only inserts what is missing,
 * so admin changes (labels, layouts, extra values) are never overwritten. Runs at signup, in the
 * seeds, and whenever the metadata service finds a tenant behind `CATALOGUE_VERSION`.
 * Returns whether anything was synced.
 */
export async function syncStandardMetadata(tx: TenantTransaction): Promise<boolean> {
  const { tenantId } = tx.context;
  const { prisma } = tx;
  const settings = await prisma.tenantSettings.findUniqueOrThrow({
    where: { tenantId },
    select: { catalogueVersion: true, defaultLocale: true },
  });
  if (settings.catalogueVersion >= CATALOGUE_VERSION) return false;
  const t = serverTranslator(settings.defaultLocale) as unknown as Translate;

  for (const apiName of METADATA_OBJECTS) {
    const def = standardObject(apiName);
    if (!def) continue;
    const singular = t(def.labelKey.singular);
    const plural = t(def.labelKey.plural);
    const object = await prisma.objectDefinition.upsert({
      where: { tenantId_apiName: { tenantId, apiName } },
      update: {},
      create: {
        tenantId,
        apiName,
        isStandard: true,
        icon: def.icon,
        color: def.color,
        recordNumberPrefix: def.recordNumberPrefix,
        nameField: def.nameField,
        features: def.features,
      },
    });
    const objectId = object.id;
    const searchable = new Set(DEFAULT_SEARCHABLE[apiName] ?? []);
    await prisma.fieldDefinition.createMany({
      data: def.fields.map((f, i) => ({
        tenantId,
        objectId,
        apiName: f.apiName,
        isStandard: true,
        type: f.type,
        required: f.required,
        system: f.system,
        isExternalId: f.apiName === 'external_id',
        isUnique: f.apiName === 'external_id',
        searchable: searchable.has(f.apiName),
        referenceTo: [...(f.references ?? [])],
        sortOrder: i,
      })),
      skipDuplicates: true,
    });
    const fields = await prisma.fieldDefinition.findMany({
      where: { objectId },
      select: { id: true, apiName: true, type: true },
    });
    const fieldId = new Map(fields.map((f) => [f.apiName, f.id]));

    const values = fields.flatMap((f) =>
      f.type === 'picklist' || f.type === 'multi_picklist'
        ? defaultPicklistValues(apiName, f.apiName).map((v, i) => ({
            tenantId,
            fieldId: f.id,
            apiValue: v.apiValue,
            category: v.category ?? null,
            isDefault: v.isDefault,
            sortOrder: i,
          }))
        : [],
    );
    if (values.length)
      await prisma.picklistValue.createMany({ data: values, skipDuplicates: true });

    await prisma.recordType.createMany({
      data: [
        {
          tenantId,
          objectId,
          apiName: 'master',
          name: t('metadata.defaults.recordType'),
          description: t('metadata.defaults.recordTypeDescription'),
          isDefault: true,
        },
      ],
      skipDuplicates: true,
    });
    if (!(await prisma.pageLayout.findFirst({ where: { objectId, isDefault: true } })))
      await prisma.pageLayout.create({
        data: {
          tenantId,
          objectId,
          name: t('metadata.defaults.pageLayout', { object: singular }),
          isDefault: true,
          sections: JSON.parse(JSON.stringify(defaultLayoutSections(def.fields))) as object,
        },
      });
    if (!(await prisma.compactLayout.findFirst({ where: { objectId, isDefault: true } })))
      await prisma.compactLayout.create({
        data: {
          tenantId,
          objectId,
          name: t('metadata.defaults.compactLayout', { object: singular }),
          isDefault: true,
          fields: [...(DEFAULT_COMPACT_FIELDS[apiName] ?? [def.nameField])],
        },
      });
    const recordNumber = fieldId.get('record_number');
    if (recordNumber)
      await prisma.autoNumberSequence.createMany({
        data: [{ tenantId, fieldId: recordNumber, format: `${def.recordNumberPrefix}-{000000}` }],
        skipDuplicates: true,
      });

    const lower = plural.toLocaleLowerCase(settings.defaultLocale);
    const nameColumns = [
      def.nameField,
      ...(DEFAULT_COMPACT_FIELDS[apiName] ?? []).filter((f) => f !== def.nameField),
    ];
    await prisma.listView.createMany({
      data: [
        {
          key: 'all',
          name: t('metadata.defaults.listViews.all', { objects: lower }),
          filter: null,
        },
        {
          key: 'mine',
          name: t('metadata.defaults.listViews.mine', { objects: lower }),
          // `$me` is resolved to the viewer by the Query Engine.
          filter: { field: 'owner_id', op: 'eq', value: '$me' },
        },
        { key: 'recent', name: t('metadata.defaults.listViews.recent'), filter: null },
      ].map((v) => ({
        tenantId,
        objectId,
        systemKey: v.key,
        name: v.name,
        visibility: 'ALL' as const,
        ...(v.filter ? { filter: v.filter } : {}),
        columns: nameColumns,
        sort: [
          {
            field: v.key === 'recent' ? 'updated_at' : def.nameField,
            direction: v.key === 'recent' ? 'desc' : 'asc',
          },
        ],
      })),
      skipDuplicates: true,
    });
  }

  await provisionDefaultPipeline(tx, t);
  await prisma.tenantSettings.update({
    where: { tenantId },
    data: { catalogueVersion: CATALOGUE_VERSION },
  });
  return true;
}

/**
 * The default sales pipeline (§4.5), created once when an organisation has none, and used by the
 * opportunity Master record type. Stages are named in the organisation's language.
 */
async function provisionDefaultPipeline(tx: TenantTransaction, t: Translate): Promise<void> {
  const { tenantId } = tx.context;
  const { prisma } = tx;
  let pipeline = await prisma.pipeline.findFirst({ where: { isDefault: true } });
  if (!pipeline) {
    pipeline = await prisma.pipeline.create({
      data: { tenantId, name: t('metadata.defaults.pipeline.name'), isDefault: true },
    });
    await prisma.pipelineStage.createMany({
      data: DEFAULT_PIPELINE_STAGES.map((s, i) => ({
        tenantId,
        pipelineId: pipeline?.id ?? '',
        apiValue: s.apiValue,
        label: t(`metadata.defaults.pipeline.stages.${camelCase(s.apiValue)}`),
        sortOrder: i,
        category: s.category,
        probability: s.probability,
        forecastCategory: s.forecastCategory,
      })),
    });
  }
  await prisma.recordType.updateMany({
    where: { apiName: 'master', pipelineId: null, object: { apiName: 'opportunity' } },
    data: { pipelineId: pipeline.id },
  });
}
