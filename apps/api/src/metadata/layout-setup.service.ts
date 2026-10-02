import { Injectable } from '@nestjs/common';
import type {
  CheckFormulaRequest,
  CheckFormulaResult,
  CompactLayoutDto,
  CreateCompactLayoutRequest,
  CreateLayoutRequest,
  CreateRecordTypeRequest,
  CreateValidationRuleRequest,
  LayoutAssignmentDto,
  PageLayoutDto,
  PathDto,
  PutLayoutAssignmentsRequest,
  PutPathRequest,
  RecordTypeDto,
  UpdateCompactLayoutRequest,
  UpdateLayoutRequest,
  UpdateRecordTypeRequest,
  UpdateValidationRuleRequest,
  ValidationRuleDto,
} from '@sm/contracts';
import { audit, type TenantTransaction } from '@sm/db';
import { checkFormula, metadataEnvironment } from '@sm/formula';
import type { MetadataIndex, ObjectMeta } from '@sm/metadata';
import { errors } from '@sm/server-kit';
import type { z } from 'zod';

import { assertVersion, invalid, isUniqueViolation } from '../setup/common.js';
import { freshMetadata } from './field-setup.service.js';
import { MetadataService } from './metadata.service.js';

type In<T extends z.ZodType> = z.infer<T>;
type Section = In<typeof CreateLayoutRequest>['sections'][number];
type Related = NonNullable<In<typeof CreateLayoutRequest>['relatedLists']>[number];

const taken = (err: unknown): never => {
  if (isUniqueViolation(err)) throw errors.conflict('That name is already in use on this object');
  throw err;
};

/**
 * Setup → Object manager: record types, page layouts and their assignments, compact layouts,
 * paths and validation rules (§5.3–§5.5). Every change is audited and bumps the metadata
 * version (triggers), so the record pages and RecordService pick it up.
 */
@Injectable()
export class LayoutSetupService {
  constructor(private readonly metadata: MetadataService) {}

  /** The object, after bringing the tenant up to the catalogue (before any change). */
  private async object(
    tx: TenantTransaction,
    name: string,
  ): Promise<{ id: string; meta: MetadataIndex; object: ObjectMeta }> {
    await this.metadata.forTenant(tx);
    const meta = await freshMetadata(tx);
    const object = meta.object(name);
    if (!object) throw errors.notFound('Object');
    return { id: object.id, meta, object };
  }

  private static audit(
    tx: TenantTransaction,
    action: string,
    entityType: string,
    id: string,
    name: string,
    after?: unknown,
  ) {
    return audit.setup(tx, {
      action,
      entityType,
      entityId: id,
      entityName: name,
      ...(after === undefined
        ? {}
        : { after: JSON.parse(JSON.stringify(after)) as Record<string, never> }),
    });
  }

  // ── Record types ──────────────────────────────────────────────────────────────────────────
  private async recordTypeDto(
    tx: TenantTransaction,
    id: string,
  ): Promise<In<typeof RecordTypeDto>> {
    const rt = await tx.prisma.recordType.findFirstOrThrow({
      where: { id },
      include: { picklistValues: { include: { picklistValue: { include: { field: true } } } } },
    });
    const values: Record<string, string[]> = {};
    for (const link of rt.picklistValues)
      (values[link.picklistValue.field.apiName] ??= []).push(link.picklistValue.apiValue);
    return {
      id: rt.id,
      apiName: rt.apiName,
      name: rt.name,
      description: rt.description,
      active: rt.active,
      isDefault: rt.isDefault,
      pipelineId: rt.pipelineId,
      picklistValues: values,
      version: rt.version,
    };
  }

  async listRecordTypes(tx: TenantTransaction, object: string) {
    const { id } = await this.object(tx, object);
    const rows = await tx.prisma.recordType.findMany({
      where: { objectId: id },
      orderBy: { createdAt: 'asc' },
    });
    return { items: await Promise.all(rows.map((r) => this.recordTypeDto(tx, r.id))) };
  }

  private async recordTypeExtras(
    tx: TenantTransaction,
    object: ObjectMeta,
    recordTypeId: string,
    body: {
      pipelineId?: string | null;
      picklistValues?: Record<string, string[]>;
      isDefault?: boolean;
    },
  ) {
    if (body.pipelineId) {
      if (object.apiName !== 'opportunity')
        throw invalid(
          'pipelineId',
          'Only opportunity record types have a pipeline',
          'not_applicable',
        );
      if (!(await tx.prisma.pipeline.findFirst({ where: { id: body.pipelineId, active: true } })))
        throw invalid('pipelineId', 'Unknown pipeline', 'invalid_reference');
    }
    if (body.isDefault)
      await tx.prisma.recordType.updateMany({
        where: { objectId: object.id, isDefault: true, NOT: { id: recordTypeId } },
        data: { isDefault: false },
      });
    for (const [field, values] of Object.entries(body.picklistValues ?? {})) {
      const f = object.fields.find((x) => x.apiName === field);
      if (!f || (f.type !== 'picklist' && f.type !== 'multi_picklist'))
        throw invalid(`picklistValues.${field}`, 'Not a picklist of this object', 'not_a_picklist');
      const rows = await tx.prisma.picklistValue.findMany({ where: { fieldId: f.id } });
      const chosen = rows.filter((r) => values.includes(r.apiValue));
      if (chosen.length !== new Set(values).size)
        throw invalid(`picklistValues.${field}`, 'Unknown value', 'invalid_value');
      await tx.prisma.recordTypePicklist.deleteMany({
        where: { recordTypeId, picklistValueId: { in: rows.map((r) => r.id) } },
      });
      await tx.prisma.recordTypePicklist.createMany({
        data: chosen.map((r) => ({
          tenantId: tx.context.tenantId,
          recordTypeId,
          picklistValueId: r.id,
        })),
      });
    }
  }

  async createRecordType(
    tx: TenantTransaction,
    objectName: string,
    body: In<typeof CreateRecordTypeRequest>,
  ) {
    const { object } = await this.object(tx, objectName);
    const rt = await tx.prisma.recordType
      .create({
        data: {
          tenantId: tx.context.tenantId,
          objectId: object.id,
          apiName: body.apiName,
          name: body.name,
          description: body.description ?? null,
          pipelineId: body.pipelineId ?? null,
          createdBy: tx.context.userId ?? null,
          updatedBy: tx.context.userId ?? null,
        },
      })
      .catch(taken);
    await this.recordTypeExtras(tx, object, rt.id, body);
    if (body.isDefault)
      await tx.prisma.recordType.update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id: rt.id } },
        data: { isDefault: true },
      });
    await LayoutSetupService.audit(
      tx,
      'record_type.created',
      'record_type',
      rt.id,
      `${objectName}.${body.apiName}`,
      body,
    );
    return this.recordTypeDto(tx, rt.id);
  }

  async updateRecordType(
    tx: TenantTransaction,
    objectName: string,
    id: string,
    body: In<typeof UpdateRecordTypeRequest>,
  ) {
    const { object } = await this.object(tx, objectName);
    const rt = await tx.prisma.recordType.findFirst({ where: { id, objectId: object.id } });
    assertVersion(rt, body.version, 'Record type');
    if (
      (body.active === false || body.isDefault === false) &&
      rt.isDefault &&
      body.isDefault !== true
    )
      throw invalid('active', 'Make another record type the default first', 'default_record_type');
    await this.recordTypeExtras(tx, object, rt.id, body);
    await tx.prisma.recordType.update({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
        ...(body.pipelineId !== undefined ? { pipelineId: body.pipelineId } : {}),
        version: { increment: 1 },
        updatedBy: tx.context.userId ?? null,
      },
    });
    await LayoutSetupService.audit(
      tx,
      'record_type.updated',
      'record_type',
      id,
      `${objectName}.${rt.apiName}`,
      body,
    );
    return this.recordTypeDto(tx, id);
  }

  // ── Page layouts ──────────────────────────────────────────────────────────────────────────
  /** Sections may only name the object's fields, once each; related lists real child lookups. */
  private static checkLayout(
    meta: MetadataIndex,
    object: ObjectMeta,
    sections?: Section[],
    related?: Related[],
  ) {
    const seen = new Set<string>();
    for (const [i, s] of (sections ?? []).entries())
      for (const f of s.fields) {
        const field = object.fields.find((x) => x.apiName === f.field);
        if (!field || field.type === 'id')
          throw invalid(
            `sections.${String(i)}`,
            `${f.field} is not a field of ${object.apiName}`,
            'unknown_field',
          );
        if (seen.has(f.field))
          throw invalid(`sections.${String(i)}`, `${f.field} appears twice`, 'duplicate_field');
        seen.add(f.field);
      }
    for (const [i, r] of (related ?? []).entries()) {
      const child = meta.object(r.object);
      const lookup = child?.fields.find((x) => x.apiName === r.field);
      if (!child || !lookup || !lookup.referenceTo.includes(object.apiName))
        throw invalid(
          `relatedLists.${String(i)}`,
          'Not a lookup to this object',
          'invalid_related_list',
        );
      const missing = [...r.columns, ...(r.sort ? [r.sort.field] : [])].find(
        (c) => !child.fields.some((x) => x.apiName === c),
      );
      if (missing)
        throw invalid(
          `relatedLists.${String(i)}`,
          `${missing} is not a field of ${r.object}`,
          'unknown_field',
        );
    }
  }

  private static layoutDto(l: {
    id: string;
    name: string;
    isDefault: boolean;
    sections: unknown;
    relatedLists: unknown;
    version: number;
  }): In<typeof PageLayoutDto> {
    return {
      id: l.id,
      name: l.name,
      isDefault: l.isDefault,
      sections: l.sections as Section[],
      relatedLists: l.relatedLists as Related[],
      version: l.version,
    };
  }

  async listLayouts(tx: TenantTransaction, object: string) {
    const { id } = await this.object(tx, object);
    const rows = await tx.prisma.pageLayout.findMany({
      where: { objectId: id },
      orderBy: { createdAt: 'asc' },
    });
    return { items: rows.map((r) => LayoutSetupService.layoutDto(r)) };
  }

  private async unsetDefault(tx: TenantTransaction, objectId: string, except: string) {
    await tx.prisma.pageLayout.updateMany({
      where: { objectId, isDefault: true, NOT: { id: except } },
      data: { isDefault: false },
    });
  }

  async createLayout(
    tx: TenantTransaction,
    objectName: string,
    body: In<typeof CreateLayoutRequest>,
  ) {
    const { meta, object } = await this.object(tx, objectName);
    LayoutSetupService.checkLayout(meta, object, body.sections, body.relatedLists);
    const row = await tx.prisma.pageLayout
      .create({
        data: {
          tenantId: tx.context.tenantId,
          objectId: object.id,
          name: body.name,
          sections: body.sections as never,
          relatedLists: (body.relatedLists ?? []) as never,
          createdBy: tx.context.userId ?? null,
          updatedBy: tx.context.userId ?? null,
        },
      })
      .catch(taken);
    if (body.isDefault) {
      await this.unsetDefault(tx, object.id, row.id);
      await tx.prisma.pageLayout.update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id: row.id } },
        data: { isDefault: true },
      });
    }
    await LayoutSetupService.audit(
      tx,
      'page_layout.created',
      'page_layout',
      row.id,
      `${objectName}.${body.name}`,
    );
    return LayoutSetupService.layoutDto(
      await tx.prisma.pageLayout.findFirstOrThrow({ where: { id: row.id } }),
    );
  }

  async updateLayout(
    tx: TenantTransaction,
    objectName: string,
    id: string,
    body: In<typeof UpdateLayoutRequest>,
  ) {
    const { meta, object } = await this.object(tx, objectName);
    const row = await tx.prisma.pageLayout.findFirst({ where: { id, objectId: object.id } });
    assertVersion(row, body.version, 'Page layout');
    if (body.isDefault === false && row.isDefault)
      throw invalid('isDefault', 'Make another layout the default first', 'default_layout');
    LayoutSetupService.checkLayout(meta, object, body.sections, body.relatedLists);
    if (body.isDefault) await this.unsetDefault(tx, object.id, id);
    const updated = await tx.prisma.pageLayout
      .update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
          ...(body.sections !== undefined ? { sections: body.sections as never } : {}),
          ...(body.relatedLists !== undefined ? { relatedLists: body.relatedLists as never } : {}),
          version: { increment: 1 },
          updatedBy: tx.context.userId ?? null,
        },
      })
      .catch(taken);
    await LayoutSetupService.audit(
      tx,
      'page_layout.updated',
      'page_layout',
      id,
      `${objectName}.${updated.name}`,
    );
    return LayoutSetupService.layoutDto(updated);
  }

  async deleteLayout(tx: TenantTransaction, objectName: string, id: string) {
    const { object } = await this.object(tx, objectName);
    const row = await tx.prisma.pageLayout.findFirst({ where: { id, objectId: object.id } });
    if (!row) throw errors.notFound('Page layout');
    if (row.isDefault) throw errors.conflict('The default layout cannot be deleted');
    await tx.prisma.pageLayout.delete({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
    });
    await LayoutSetupService.audit(
      tx,
      'page_layout.deleted',
      'page_layout',
      id,
      `${objectName}.${row.name}`,
    );
  }

  // ── Layout assignments ────────────────────────────────────────────────────────────────────
  async getAssignments(
    tx: TenantTransaction,
    objectName: string,
  ): Promise<{ items: In<typeof LayoutAssignmentDto>[] }> {
    const { object } = await this.object(tx, objectName);
    const rows = await tx.prisma.layoutAssignment.findMany({ where: { objectId: object.id } });
    return {
      items: rows.map((r) => ({
        profileId: r.profileId,
        recordTypeId: r.recordTypeId,
        pageLayoutId: r.pageLayoutId,
      })),
    };
  }

  async putAssignments(
    tx: TenantTransaction,
    objectName: string,
    body: In<typeof PutLayoutAssignmentsRequest>,
  ) {
    const { object } = await this.object(tx, objectName);
    const ids = (k: 'profileId' | 'recordTypeId' | 'pageLayoutId') => [
      ...new Set(body.assignments.map((a) => a[k])),
    ];
    const [profiles, types, layouts] = [
      await tx.prisma.profile.count({ where: { id: { in: ids('profileId') }, deletedAt: null } }),
      await tx.prisma.recordType.count({
        where: { id: { in: ids('recordTypeId') }, objectId: object.id },
      }),
      await tx.prisma.pageLayout.count({
        where: { id: { in: ids('pageLayoutId') }, objectId: object.id },
      }),
    ];
    if (
      profiles !== ids('profileId').length ||
      types !== ids('recordTypeId').length ||
      layouts !== ids('pageLayoutId').length
    )
      throw invalid(
        'assignments',
        'Unknown profile, or a record type or layout of another object',
        'invalid_reference',
      );
    const keys = new Set(body.assignments.map((a) => `${a.profileId}:${a.recordTypeId}`));
    if (keys.size !== body.assignments.length)
      throw invalid(
        'assignments',
        'One layout per profile and record type',
        'duplicate_assignment',
      );
    await tx.prisma.layoutAssignment.deleteMany({ where: { objectId: object.id } });
    await tx.prisma.layoutAssignment.createMany({
      data: body.assignments.map((a) => ({
        tenantId: tx.context.tenantId,
        objectId: object.id,
        ...a,
        createdBy: tx.context.userId ?? null,
      })),
    });
    await LayoutSetupService.audit(
      tx,
      'layout_assignments.replaced',
      'object',
      object.id,
      objectName,
      {
        count: body.assignments.length,
      },
    );
    return this.getAssignments(tx, objectName);
  }

  // ── Compact layouts ───────────────────────────────────────────────────────────────────────
  private static checkCompact(object: ObjectMeta, fields?: string[]) {
    for (const f of fields ?? [])
      if (!object.fields.some((x) => x.apiName === f))
        throw invalid('fields', `${f} is not a field of ${object.apiName}`, 'unknown_field');
    if (fields && new Set(fields).size !== fields.length)
      throw invalid('fields', 'A field appears twice', 'duplicate_field');
  }

  private static compactDto(c: {
    id: string;
    name: string;
    isDefault: boolean;
    fields: string[];
    version: number;
  }): In<typeof CompactLayoutDto> {
    return { id: c.id, name: c.name, isDefault: c.isDefault, fields: c.fields, version: c.version };
  }

  async listCompact(tx: TenantTransaction, object: string) {
    const { id } = await this.object(tx, object);
    const rows = await tx.prisma.compactLayout.findMany({
      where: { objectId: id },
      orderBy: { createdAt: 'asc' },
    });
    return { items: rows.map((r) => LayoutSetupService.compactDto(r)) };
  }

  async createCompact(
    tx: TenantTransaction,
    objectName: string,
    body: In<typeof CreateCompactLayoutRequest>,
  ) {
    const { object } = await this.object(tx, objectName);
    LayoutSetupService.checkCompact(object, body.fields);
    if (body.isDefault)
      await tx.prisma.compactLayout.updateMany({
        where: { objectId: object.id, isDefault: true },
        data: { isDefault: false },
      });
    const row = await tx.prisma.compactLayout
      .create({
        data: {
          tenantId: tx.context.tenantId,
          objectId: object.id,
          name: body.name,
          fields: body.fields,
          isDefault: body.isDefault ?? false,
          createdBy: tx.context.userId ?? null,
          updatedBy: tx.context.userId ?? null,
        },
      })
      .catch(taken);
    await LayoutSetupService.audit(
      tx,
      'compact_layout.created',
      'compact_layout',
      row.id,
      `${objectName}.${body.name}`,
      body,
    );
    return LayoutSetupService.compactDto(row);
  }

  async updateCompact(
    tx: TenantTransaction,
    objectName: string,
    id: string,
    body: In<typeof UpdateCompactLayoutRequest>,
  ) {
    const { object } = await this.object(tx, objectName);
    const row = await tx.prisma.compactLayout.findFirst({ where: { id, objectId: object.id } });
    assertVersion(row, body.version, 'Compact layout');
    if (body.isDefault === false && row.isDefault)
      throw invalid('isDefault', 'Make another compact layout the default first', 'default_layout');
    LayoutSetupService.checkCompact(object, body.fields);
    if (body.isDefault)
      await tx.prisma.compactLayout.updateMany({
        where: { objectId: object.id, isDefault: true, NOT: { id } },
        data: { isDefault: false },
      });
    const updated = await tx.prisma.compactLayout
      .update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
          ...(body.fields !== undefined ? { fields: body.fields } : {}),
          version: { increment: 1 },
          updatedBy: tx.context.userId ?? null,
        },
      })
      .catch(taken);
    await LayoutSetupService.audit(
      tx,
      'compact_layout.updated',
      'compact_layout',
      id,
      `${objectName}.${updated.name}`,
      body,
    );
    return LayoutSetupService.compactDto(updated);
  }

  async deleteCompact(tx: TenantTransaction, objectName: string, id: string) {
    const { object } = await this.object(tx, objectName);
    const row = await tx.prisma.compactLayout.findFirst({ where: { id, objectId: object.id } });
    if (!row) throw errors.notFound('Compact layout');
    if (row.isDefault) throw errors.conflict('The default compact layout cannot be deleted');
    await tx.prisma.compactLayout.delete({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
    });
    await LayoutSetupService.audit(
      tx,
      'compact_layout.deleted',
      'compact_layout',
      id,
      `${objectName}.${row.name}`,
    );
  }

  // ── Paths ─────────────────────────────────────────────────────────────────────────────────
  private static pathDto(
    p: { id: string; recordTypeId: string; active: boolean; steps: unknown; version: number },
    field: string,
  ): In<typeof PathDto> {
    return {
      id: p.id,
      recordTypeId: p.recordTypeId,
      field,
      active: p.active,
      steps: p.steps as In<typeof PathDto>['steps'],
      version: p.version,
    };
  }

  async listPaths(tx: TenantTransaction, objectName: string) {
    const { object } = await this.object(tx, objectName);
    const rows = await tx.prisma.pathSetting.findMany({
      where: { recordType: { objectId: object.id } },
      include: { field: { select: { apiName: true } } },
    });
    return { items: rows.map((r) => LayoutSetupService.pathDto(r, r.field.apiName)) };
  }

  async putPath(
    tx: TenantTransaction,
    objectName: string,
    recordTypeId: string,
    field: string,
    body: In<typeof PutPathRequest>,
  ) {
    const { object } = await this.object(tx, objectName);
    const rt = await tx.prisma.recordType.findFirst({
      where: { id: recordTypeId, objectId: object.id },
    });
    if (!rt) throw errors.notFound('Record type');
    const f = object.fields.find((x) => x.apiName === field);
    if (!f) throw errors.notFound('Field');
    if (f.type !== 'picklist') throw invalid('field', 'Paths follow a picklist', 'not_a_picklist');
    // Steps are picklist values (opportunity stages: any stage of any pipeline).
    const known =
      objectName === 'opportunity' && field === 'stage'
        ? (await tx.prisma.pipelineStage.findMany({ select: { apiValue: true } })).map(
            (s) => s.apiValue,
          )
        : f.picklistValues.map((v) => v.apiValue);
    for (const [step, s] of Object.entries(body.steps)) {
      if (!known.includes(step))
        throw invalid(`steps.${step}`, 'Not a value of this picklist', 'invalid_value');
      const missing = s.keyFields.find((k) => !object.fields.some((x) => x.apiName === k));
      if (missing)
        throw invalid(
          `steps.${step}`,
          `${missing} is not a field of ${objectName}`,
          'unknown_field',
        );
    }
    const tenantId = tx.context.tenantId;
    const row = await tx.prisma.pathSetting.upsert({
      where: { tenantId_recordTypeId_fieldId: { tenantId, recordTypeId, fieldId: f.id } },
      create: {
        tenantId,
        recordTypeId,
        fieldId: f.id,
        active: body.active,
        steps: body.steps as never,
        createdBy: tx.context.userId ?? null,
        updatedBy: tx.context.userId ?? null,
      },
      update: {
        active: body.active,
        steps: body.steps as never,
        version: { increment: 1 },
        updatedBy: tx.context.userId ?? null,
      },
    });
    await LayoutSetupService.audit(
      tx,
      'path.set',
      'path_setting',
      row.id,
      `${objectName}.${rt.apiName}.${field}`,
    );
    return LayoutSetupService.pathDto(row, field);
  }

  async deletePath(tx: TenantTransaction, objectName: string, recordTypeId: string, field: string) {
    const { object } = await this.object(tx, objectName);
    const f = object.fields.find((x) => x.apiName === field);
    const deleted = f
      ? await tx.prisma.pathSetting.deleteMany({
          where: { recordTypeId, fieldId: f.id, recordType: { objectId: object.id } },
        })
      : { count: 0 };
    if (deleted.count === 0) throw errors.notFound('Path');
    await LayoutSetupService.audit(
      tx,
      'path.deleted',
      'path_setting',
      recordTypeId,
      `${objectName}.${field}`,
    );
  }

  // ── Validation rules ──────────────────────────────────────────────────────────────────────
  /** A rule's formula must type check as Boolean against the object's metadata (§5.5). */
  private static checkRule(
    meta: MetadataIndex,
    object: ObjectMeta,
    formula?: string,
    errorField?: string | null,
  ) {
    if (formula !== undefined) {
      const checked = checkFormula(
        formula,
        metadataEnvironment(meta, object.apiName, { allowPriorValues: true }),
        'Boolean',
      );
      if (!checked.ok)
        throw errors.validation([
          {
            field: 'formula',
            code: `formula.${checked.error.code}`,
            message: `${checked.error.code} at ${String(checked.error.span.start)}–${String(checked.error.span.end)}`,
          },
        ]);
    }
    if (errorField && !object.fields.some((f) => f.apiName === errorField))
      throw invalid(
        'errorField',
        `${errorField} is not a field of ${object.apiName}`,
        'unknown_field',
      );
  }

  private static ruleDto(r: {
    id: string;
    apiName: string;
    description: string | null;
    formula: string;
    errorMessage: string;
    errorField: string | null;
    active: boolean;
    version: number;
  }): In<typeof ValidationRuleDto> {
    return {
      id: r.id,
      apiName: r.apiName,
      description: r.description,
      formula: r.formula,
      errorMessage: r.errorMessage,
      errorField: r.errorField,
      active: r.active,
      version: r.version,
    };
  }

  /** Type-check a formula without saving (the rule editor's inline errors, §5.5). */
  async checkFormula(
    tx: TenantTransaction,
    objectName: string,
    body: In<typeof CheckFormulaRequest>,
  ): Promise<In<typeof CheckFormulaResult>> {
    const { meta, object } = await this.object(tx, objectName);
    const checked = checkFormula(
      body.formula,
      metadataEnvironment(meta, object.apiName, { allowPriorValues: true }),
      body.expected,
    );
    return checked.ok
      ? { ok: true, type: checked.type, error: null }
      : {
          ok: false,
          type: null,
          error: {
            code: checked.error.code,
            params: checked.error.params,
            start: checked.error.span.start,
            end: checked.error.span.end,
          },
        };
  }

  async listRules(tx: TenantTransaction, object: string) {
    const { id } = await this.object(tx, object);
    const rows = await tx.prisma.validationRule.findMany({
      where: { objectId: id },
      orderBy: { apiName: 'asc' },
    });
    return { items: rows.map((r) => LayoutSetupService.ruleDto(r)) };
  }

  async createRule(
    tx: TenantTransaction,
    objectName: string,
    body: In<typeof CreateValidationRuleRequest>,
  ) {
    const { meta, object } = await this.object(tx, objectName);
    LayoutSetupService.checkRule(meta, object, body.formula, body.errorField);
    const row = await tx.prisma.validationRule
      .create({
        data: {
          tenantId: tx.context.tenantId,
          objectId: object.id,
          apiName: body.apiName,
          description: body.description ?? null,
          formula: body.formula,
          errorMessage: body.errorMessage,
          errorField: body.errorField ?? null,
          active: body.active ?? true,
          createdBy: tx.context.userId ?? null,
          updatedBy: tx.context.userId ?? null,
        },
      })
      .catch(taken);
    await LayoutSetupService.audit(
      tx,
      'validation_rule.created',
      'validation_rule',
      row.id,
      `${objectName}.${body.apiName}`,
      body,
    );
    return LayoutSetupService.ruleDto(row);
  }

  async updateRule(
    tx: TenantTransaction,
    objectName: string,
    id: string,
    body: In<typeof UpdateValidationRuleRequest>,
  ) {
    const { meta, object } = await this.object(tx, objectName);
    const row = await tx.prisma.validationRule.findFirst({ where: { id, objectId: object.id } });
    assertVersion(row, body.version, 'Validation rule');
    LayoutSetupService.checkRule(meta, object, body.formula, body.errorField);
    const updated = await tx.prisma.validationRule.update({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
      data: {
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.formula !== undefined ? { formula: body.formula } : {}),
        ...(body.errorMessage !== undefined ? { errorMessage: body.errorMessage } : {}),
        ...(body.errorField !== undefined ? { errorField: body.errorField } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        version: { increment: 1 },
        updatedBy: tx.context.userId ?? null,
      },
    });
    await LayoutSetupService.audit(
      tx,
      'validation_rule.updated',
      'validation_rule',
      id,
      `${objectName}.${row.apiName}`,
      body,
    );
    return LayoutSetupService.ruleDto(updated);
  }

  async deleteRule(tx: TenantTransaction, objectName: string, id: string) {
    const { object } = await this.object(tx, objectName);
    const row = await tx.prisma.validationRule.findFirst({ where: { id, objectId: object.id } });
    if (!row) throw errors.notFound('Validation rule');
    await tx.prisma.validationRule.delete({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
    });
    await LayoutSetupService.audit(
      tx,
      'validation_rule.deleted',
      'validation_rule',
      id,
      `${objectName}.${row.apiName}`,
    );
  }
}
