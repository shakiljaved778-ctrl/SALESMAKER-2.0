import { Injectable } from '@nestjs/common';
import type {
  CreateFieldRequest,
  FieldSettingDto,
  PutPicklistValuesRequest,
  UpdateFieldRequest,
} from '@sm/contracts';
import { audit, loadTenantMetadata, type TenantTransaction } from '@sm/db';
import {
  LEAD_STATUS_CATEGORIES,
  MetadataIndex,
  normaliseValue,
  type FieldMeta,
} from '@sm/metadata';
import { errors } from '@sm/server-kit';
import type { z } from 'zod';

import { assertVersion, invalid } from '../setup/common.js';
import { MetadataService } from './metadata.service.js';

type FieldSetting = z.infer<typeof FieldSettingDto>;
type PicklistRow = Awaited<
  ReturnType<TenantTransaction['prisma']['picklistValue']['findFirstOrThrow']>
>;
type FieldRow = Awaited<
  ReturnType<TenantTransaction['prisma']['fieldDefinition']['findFirstOrThrow']>
>;

/** Custom fields per object (until plans set it, P05). */
export const MAX_CUSTOM_FIELDS = 500;
/** Indexed custom fields per object (Q11, ADR-0030). */
export const MAX_INDEXED = 10;

const TEXT_LIMITS: Record<string, { default: number; max: number }> = {
  text: { default: 255, max: 255 },
  textarea: { default: 4000, max: 4000 },
  long_text: { default: 32_768, max: 131_072 },
  email: { default: 254, max: 254 },
  phone: { default: 40, max: 40 },
  url: { default: 2048, max: 2048 },
};
const NUMERIC = new Set(['number', 'currency', 'percent']);
const PICKLISTS = new Set(['picklist', 'multi_picklist']);
/** text → textarea → long_text: each holds what the previous one held. */
const WIDENS: Record<string, readonly string[]> = {
  text: ['textarea', 'long_text'],
  textarea: ['long_text'],
};
const LOOKUP_TARGETS = new Set(['lead', 'account', 'contact', 'opportunity', 'campaign', 'user']);

const isCheckViolation = (err: unknown) =>
  /check_violation|23514|at most 60 tracked/.test(
    `${String((err as { code?: unknown }).code)} ${err instanceof Error ? err.message : ''}`,
  );

/**
 * Setup → Object manager → fields (§5.2). Custom fields live in `custom` jsonb under their
 * `<name>__c` API name, which never changes; type changes are limited to safe widenings, so
 * stored values always stay valid.
 */
/**
 * The tenant's metadata as this transaction sees it, never from the cache: a Setup change bumps
 * the metadata version inside the transaction, and a rolled-back version must never be cached.
 */
export async function freshMetadata(tx: TenantTransaction): Promise<MetadataIndex> {
  const { metadataVersion } = await tx.prisma.tenantSettings.findUniqueOrThrow({
    where: { tenantId: tx.context.tenantId },
    select: { metadataVersion: true },
  });
  return new MetadataIndex(await loadTenantMetadata(tx, metadataVersion));
}

@Injectable()
export class FieldSetupService {
  constructor(private readonly metadata: MetadataService) {}

  /**
   * Bring a tenant behind the catalogue up to date. Called first in every operation, before any
   * change in the transaction, so what the metadata cache stores is committed state.
   */
  private async ready(tx: TenantTransaction): Promise<void> {
    await this.metadata.forTenant(tx);
  }

  private async objectId(tx: TenantTransaction, object: string): Promise<string> {
    const row = await tx.prisma.objectDefinition.findFirst({
      where: { apiName: object, deletedAt: null },
      select: { id: true },
    });
    if (!row) throw errors.notFound('Object');
    return row.id;
  }

  private async field(tx: TenantTransaction, object: string, apiName: string): Promise<FieldRow> {
    const objectId = await this.objectId(tx, object);
    const row = await tx.prisma.fieldDefinition.findFirst({
      where: { objectId, apiName, deletedAt: null },
    });
    if (!row) throw errors.notFound('Field');
    return row;
  }

  private async dto(tx: TenantTransaction, object: string, apiName: string): Promise<FieldSetting> {
    const metadata = await freshMetadata(tx);
    const f = metadata.field(object, apiName);
    const row = await this.field(tx, object, apiName);
    if (!f) throw errors.notFound('Field');
    const values = await tx.prisma.picklistValue.findMany({
      where: { fieldId: row.id },
      orderBy: { sortOrder: 'asc' },
    });
    return this.present(f, row, await this.indexStatus(tx, row.id), values);
  }

  private async indexStatus(tx: TenantTransaction, fieldId: string): Promise<string | null> {
    const index = await tx.prisma.customFieldIndex.findUnique({
      where: { tenantId_fieldId: { tenantId: tx.context.tenantId, fieldId } },
    });
    return index?.status ?? null;
  }

  private present(
    f: FieldMeta,
    row: FieldRow,
    indexStatus: string | null,
    values: readonly PicklistRow[],
  ): FieldSetting {
    return {
      id: f.id,
      apiName: f.apiName,
      custom: !f.isStandard,
      type: f.type,
      label: f.label,
      labelKey: f.labelKey,
      description: f.description,
      helpText: f.helpText,
      required: f.required,
      unique: f.unique,
      system: f.system,
      externalId: f.externalId,
      searchable: f.searchable,
      trackHistory: f.trackHistory,
      indexed: f.indexed,
      indexStatus,
      length: f.length,
      precision: f.precision,
      scale: f.scale,
      referenceTo: f.referenceTo,
      defaultValue: f.defaultValue ?? null,
      picklistValues: values.map((v) => ({
        id: v.id,
        apiValue: v.apiValue,
        label: v.label,
        labelKey: f.picklistValues.find((m) => m.apiValue === v.apiValue)?.labelKey ?? null,
        active: v.active,
        isDefault: v.isDefault,
        category: v.category,
        sortOrder: v.sortOrder,
      })),
      version: row.version,
    };
  }

  async list(tx: TenantTransaction, object: string): Promise<{ items: FieldSetting[] }> {
    await this.ready(tx);
    const objectId = await this.objectId(tx, object);
    const metadata = await freshMetadata(tx);
    const rows = await tx.prisma.fieldDefinition.findMany({ where: { objectId, deletedAt: null } });
    const indexes = new Map(
      (await tx.prisma.customFieldIndex.findMany()).map((i) => [i.fieldId, i.status as string]),
    );
    const values = await tx.prisma.picklistValue.findMany({
      where: { fieldId: { in: rows.map((r) => r.id) } },
      orderBy: { sortOrder: 'asc' },
    });
    const items: FieldSetting[] = [];
    for (const f of metadata.object(object)?.fields ?? []) {
      const row = rows.find((r) => r.id === f.id);
      if (row)
        items.push(
          this.present(
            f,
            row,
            indexes.get(f.id) ?? null,
            values.filter((v) => v.fieldId === row.id),
          ),
        );
    }
    return { items };
  }

  /** A default value must be a valid value of the field (checked against the saved metadata). */
  private async checkDefault(tx: TenantTransaction, object: string, apiName: string) {
    const metadata = await freshMetadata(tx);
    const f = metadata.field(object, apiName);
    if (!f || f.defaultValue === null || f.defaultValue === undefined) return;
    const allowed = PICKLISTS.has(f.type)
      ? f.picklistValues.filter((v) => v.active).map((v) => v.apiValue)
      : undefined;
    const result = normaliseValue({ ...f, system: false }, f.defaultValue, allowed);
    if (!result.ok) throw invalid('defaultValue', 'Not a valid value for this field', result.code);
  }

  private async requestIndex(tx: TenantTransaction, objectId: string, fieldId: string) {
    const indexed = await tx.prisma.fieldDefinition.count({
      where: { objectId, indexed: true, deletedAt: null, NOT: { id: fieldId } },
    });
    if (indexed >= MAX_INDEXED)
      throw errors.conflict(`At most ${String(MAX_INDEXED)} indexed custom fields per object`);
    const tenantHex = tx.context.tenantId.replace(/-/g, '').slice(0, 12);
    await tx.prisma.customFieldIndex.upsert({
      where: { tenantId_fieldId: { tenantId: tx.context.tenantId, fieldId } },
      create: {
        tenantId: tx.context.tenantId,
        fieldId,
        indexName: `cfi_${tenantHex}_${fieldId.replace(/-/g, '')}`,
      },
      update: {},
    });
    // The index is built by a worker job once its mechanism is settled (ADR-0030, P02 notes);
    // until then the request is recorded as PENDING.
  }

  async create(
    tx: TenantTransaction,
    object: string,
    body: z.infer<typeof CreateFieldRequest>,
  ): Promise<FieldSetting> {
    await this.ready(tx);
    const objectId = await this.objectId(tx, object);
    const apiName = `${body.name}__c`;
    const tenantId = tx.context.tenantId;
    const count = await tx.prisma.fieldDefinition.count({
      where: { objectId, isStandard: false, deletedAt: null },
    });
    if (count >= MAX_CUSTOM_FIELDS)
      throw errors.conflict(`At most ${String(MAX_CUSTOM_FIELDS)} custom fields per object`);
    if (await tx.prisma.fieldDefinition.findFirst({ where: { objectId, apiName } }))
      throw errors.conflict('A field with that name exists (or existed) on this object');

    const text = TEXT_LIMITS[body.type];
    if (body.length !== undefined && (!text || body.length > text.max))
      throw invalid(
        'length',
        'Length does not apply or is too long for this type',
        'invalid_length',
      );
    const numeric = NUMERIC.has(body.type);
    if ((body.precision !== undefined || body.scale !== undefined) && !numeric)
      throw invalid('precision', 'Precision applies to numbers only', 'not_applicable');
    const precision = numeric ? (body.precision ?? 18) : null;
    // Money is numeric(18,2) (golden rule 8): currency fields always keep two decimals.
    const scale = numeric ? (body.type === 'currency' ? 2 : (body.scale ?? 0)) : null;
    if (precision !== null && scale !== null && scale >= precision)
      throw invalid('scale', 'Scale must be smaller than precision', 'invalid_scale');
    if (PICKLISTS.has(body.type) !== Boolean(body.picklistValues?.length))
      throw invalid(
        'picklistValues',
        'Picklists need values; other types take none',
        PICKLISTS.has(body.type) ? 'required' : 'not_applicable',
      );
    if ((body.type === 'lookup') !== (body.referenceTo !== undefined))
      throw invalid(
        'referenceTo',
        'Lookups need a target object; other types take none',
        'invalid',
      );
    if (body.referenceTo !== undefined && !LOOKUP_TARGETS.has(body.referenceTo))
      throw invalid('referenceTo', 'Not an object a lookup can point at', 'invalid_target');

    const created = await tx.prisma.fieldDefinition
      .create({
        data: {
          tenantId,
          objectId,
          apiName,
          isStandard: false,
          type: body.type,
          label: body.label,
          description: body.description ?? null,
          helpText: body.helpText ?? null,
          required: body.required ?? false,
          trackHistory: body.trackHistory ?? false,
          indexed: body.indexed ?? false,
          length: text ? (body.length ?? text.default) : null,
          precision,
          scale,
          referenceTo: body.referenceTo ? [body.referenceTo] : [],
          defaultValue: body.defaultValue === undefined ? undefined : (body.defaultValue as never),
          sortOrder: 10_000 + count,
          createdBy: tx.context.userId ?? null,
          updatedBy: tx.context.userId ?? null,
        },
      })
      .catch((err: unknown) => {
        if (isCheckViolation(err)) throw errors.conflict('At most 60 tracked fields per object');
        throw err;
      });
    if (body.picklistValues) await this.writeValues(tx, object, created.id, body.picklistValues);
    if (body.indexed) await this.requestIndex(tx, objectId, created.id);
    await this.checkDefault(tx, object, apiName);

    // FLS: the System Administrator profile always sees new fields; others as the request says.
    const admin = await tx.prisma.profile.findFirst({
      where: { systemKey: 'system_administrator', deletedAt: null },
      select: { permissionSetId: true },
    });
    const access = new Map<string, { read: boolean; edit: boolean }>();
    for (const a of body.access ?? [])
      access.set(a.permissionSetId, { read: a.read || a.edit, edit: a.edit });
    if (admin) access.set(admin.permissionSetId, { read: true, edit: true });
    if (access.size) {
      const sets = await tx.prisma.permissionSet.findMany({
        where: { id: { in: [...access.keys()] }, deletedAt: null },
        select: { id: true },
      });
      if (sets.length !== access.size)
        throw invalid('access', 'Unknown permission set', 'invalid_reference');
      await tx.prisma.fieldPermission.createMany({
        data: [...access].map(([permissionSetId, a]) => ({
          tenantId,
          permissionSetId,
          object,
          field: apiName,
          canRead: a.read,
          canEdit: a.edit,
        })),
      });
      await tx.prisma.tenantSettings.update({
        where: { tenantId },
        data: { permVersion: { increment: 1 } },
      });
    }
    await audit.setup(tx, {
      action: 'field.created',
      entityType: 'field',
      entityId: created.id,
      entityName: `${object}.${apiName}`,
      after: { type: body.type, label: body.label, required: body.required ?? false },
    });
    return this.dto(tx, object, apiName);
  }

  async update(
    tx: TenantTransaction,
    object: string,
    apiName: string,
    body: z.infer<typeof UpdateFieldRequest>,
  ): Promise<FieldSetting> {
    await this.ready(tx);
    const row = await this.field(tx, object, apiName);
    assertVersion(row, body.version, 'Field');
    if (row.system) throw invalid('field', 'System fields cannot be changed', 'system_field');
    const changes = Object.keys(body).filter((k) => k !== 'version');
    const standardOnly = new Set(['label', 'description', 'helpText', 'trackHistory']);
    if (row.isStandard && changes.some((k) => !standardOnly.has(k)))
      throw invalid(
        changes.find((k) => !standardOnly.has(k)) ?? 'field',
        'Standard fields only take a label, description, help text and history tracking',
        'standard_field',
      );
    const type = body.type ?? row.type;
    if (body.type && body.type !== row.type && !(WIDENS[row.type] ?? []).includes(body.type))
      throw invalid('type', `A ${row.type} field cannot become ${body.type}`, 'unsafe_type_change');
    const text = TEXT_LIMITS[type];
    let length = row.length;
    if (body.type && body.type !== row.type && text)
      length = Math.max(row.length ?? 0, text.default);
    if (body.length !== undefined) {
      if (!text || body.length > text.max)
        throw invalid('length', 'Length does not apply or is too long', 'invalid_length');
      if (body.length < (row.length ?? 0))
        throw invalid('length', 'Fields can grow, never shrink', 'narrowing');
      length = body.length;
    }
    let precision = row.precision;
    if (body.precision !== undefined) {
      if (!NUMERIC.has(type)) throw invalid('precision', 'Numbers only', 'not_applicable');
      if (body.precision < (row.precision ?? 0))
        throw invalid('precision', 'Fields can grow, never shrink', 'narrowing');
      precision = body.precision;
    }
    if (body.scale !== undefined && body.scale !== row.scale)
      throw invalid('scale', 'The number of decimals cannot change', 'scale_fixed');
    if (body.indexed === true && !row.indexed) await this.requestIndex(tx, row.objectId, row.id);
    if (body.indexed === false && row.indexed)
      await tx.prisma.customFieldIndex.deleteMany({ where: { fieldId: row.id } });

    await tx.prisma.fieldDefinition
      .update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id: row.id } },
        data: {
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.helpText !== undefined ? { helpText: body.helpText } : {}),
          ...(body.required !== undefined ? { required: body.required } : {}),
          ...(body.trackHistory !== undefined ? { trackHistory: body.trackHistory } : {}),
          ...(body.indexed !== undefined ? { indexed: body.indexed } : {}),
          ...(body.defaultValue !== undefined ? { defaultValue: body.defaultValue as never } : {}),
          type,
          length,
          precision,
          version: { increment: 1 },
          updatedBy: tx.context.userId ?? null,
        },
      })
      .catch((err: unknown) => {
        if (isCheckViolation(err)) throw errors.conflict('At most 60 tracked fields per object');
        throw err;
      });
    await this.checkDefault(tx, object, apiName);
    await audit.setup(tx, {
      action: 'field.updated',
      entityType: 'field',
      entityId: row.id,
      entityName: `${object}.${apiName}`,
      before: JSON.parse(
        JSON.stringify(
          Object.fromEntries(changes.map((k) => [k, (row as Record<string, unknown>)[k] ?? null])),
        ),
      ) as Record<string, never>,
      after: JSON.parse(
        JSON.stringify(
          Object.fromEntries(changes.map((k) => [k, (body as Record<string, unknown>)[k] ?? null])),
        ),
      ) as Record<string, never>,
    });
    return this.dto(tx, object, apiName);
  }

  async remove(tx: TenantTransaction, object: string, apiName: string): Promise<void> {
    await this.ready(tx);
    const row = await this.field(tx, object, apiName);
    if (row.isStandard)
      throw invalid('field', 'Standard fields cannot be deleted', 'standard_field');
    const word = new RegExp(`\\b${apiName}\\b`);
    const rules = await tx.prisma.validationRule.findMany({ where: { objectId: row.objectId } });
    if (rules.some((r) => word.test(r.formula)))
      throw errors.conflict('A validation rule uses this field; change the rule first');
    if (await tx.prisma.pathSetting.findFirst({ where: { fieldId: row.id } }))
      throw errors.conflict('A path uses this field; remove the path first');
    const tenantId = tx.context.tenantId;
    await tx.prisma.fieldDefinition.update({
      where: { tenantId_id: { tenantId, id: row.id } },
      data: {
        deletedAt: new Date(),
        indexed: false,
        trackHistory: false,
        updatedBy: tx.context.userId ?? null,
      },
    });
    await tx.prisma.fieldPermission.deleteMany({ where: { object, field: apiName } });
    await tx.prisma.customFieldIndex.deleteMany({ where: { fieldId: row.id } });
    // Out of layouts and compact layouts too, so no screen asks for a field that is gone.
    const objectId = row.objectId;
    for (const layout of await tx.prisma.pageLayout.findMany({ where: { objectId } })) {
      const sections = (layout.sections as { fields?: { field: string }[] }[]).map((s) => ({
        ...s,
        fields: (s.fields ?? []).filter((f) => f.field !== apiName),
      }));
      await tx.prisma.pageLayout.update({
        where: { tenantId_id: { tenantId, id: layout.id } },
        data: { sections: sections as never },
      });
    }
    for (const compact of await tx.prisma.compactLayout.findMany({ where: { objectId } }))
      if (compact.fields.includes(apiName) && compact.fields.length > 1)
        await tx.prisma.compactLayout.update({
          where: { tenantId_id: { tenantId, id: compact.id } },
          data: { fields: compact.fields.filter((f) => f !== apiName) },
        });
    await tx.prisma.tenantSettings.update({
      where: { tenantId },
      data: { permVersion: { increment: 1 } },
    });
    await audit.setup(tx, {
      action: 'field.deleted',
      entityType: 'field',
      entityId: row.id,
      entityName: `${object}.${apiName}`,
      before: { type: row.type, label: row.label },
    });
    // Values stay in records' `custom` (invisible without a definition); the name is not reused.
  }

  /** Write a picklist's values in order: update known ones, add new ones, deactivate the rest. */
  private async writeValues(
    tx: TenantTransaction,
    object: string,
    fieldId: string,
    values: z.infer<typeof PutPicklistValuesRequest>['values'],
  ): Promise<void> {
    const seen = new Set<string>();
    for (const v of values) {
      if (seen.has(v.apiValue))
        throw invalid('values', `${v.apiValue} is listed twice`, 'duplicate_value');
      seen.add(v.apiValue);
    }
    const isLeadStatus = object === 'lead' && values.some((v) => v.category !== undefined);
    for (const v of values)
      if (v.category !== undefined && v.category !== null) {
        if (!isLeadStatus || !(LEAD_STATUS_CATEGORIES as readonly string[]).includes(v.category))
          throw invalid('values', `Category ${v.category} does not apply`, 'invalid_category');
      }
    if (values.filter((v) => v.isDefault).length > 1)
      throw invalid('values', 'At most one default value', 'one_default');
    if (!values.some((v) => v.active !== false))
      throw invalid('values', 'At least one value must be active', 'none_active');
    const tenantId = tx.context.tenantId;
    const existing = await tx.prisma.picklistValue.findMany({ where: { fieldId } });
    for (const [i, v] of values.entries()) {
      const known = existing.find((e) => e.apiValue === v.apiValue);
      const data = {
        ...(v.label !== undefined ? { label: v.label } : {}),
        active: v.active ?? true,
        isDefault: v.isDefault ?? false,
        ...(v.category !== undefined ? { category: v.category } : {}),
        sortOrder: i,
      };
      if (known)
        await tx.prisma.picklistValue.update({
          where: { tenantId_id: { tenantId, id: known.id } },
          data,
        });
      else
        await tx.prisma.picklistValue.create({
          data: { tenantId, fieldId, apiValue: v.apiValue, ...data, label: v.label ?? null },
        });
    }
    for (const e of existing.filter((x) => !seen.has(x.apiValue)))
      await tx.prisma.picklistValue.update({
        where: { tenantId_id: { tenantId, id: e.id } },
        data: { active: false, isDefault: false, sortOrder: values.length + e.sortOrder },
      });
  }

  async putValues(
    tx: TenantTransaction,
    object: string,
    apiName: string,
    body: z.infer<typeof PutPicklistValuesRequest>,
  ): Promise<FieldSetting> {
    await this.ready(tx);
    const row = await this.field(tx, object, apiName);
    if (!PICKLISTS.has(row.type)) throw invalid('field', 'Not a picklist', 'not_a_picklist');
    assertVersion(row, body.version, 'Field');
    if (object === 'opportunity' && apiName === 'stage')
      throw invalid('field', 'Stages come from pipelines', 'pipeline_stages');
    await this.writeValues(tx, object, row.id, body.values);
    await tx.prisma.fieldDefinition.update({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id: row.id } },
      data: { version: { increment: 1 }, updatedBy: tx.context.userId ?? null },
    });
    await this.checkDefault(tx, object, apiName);
    await audit.setup(tx, {
      action: 'field.picklist_values_set',
      entityType: 'field',
      entityId: row.id,
      entityName: `${object}.${apiName}`,
      after: { values: body.values.map((v) => v.apiValue) },
    });
    return this.dto(tx, object, apiName);
  }
}
