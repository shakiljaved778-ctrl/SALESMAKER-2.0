import { Injectable } from '@nestjs/common';
import type { FieldHistoryDto, RecordPageDto } from '@sm/contracts';
import type { TenantTransaction } from '@sm/db';
import { serverTranslator } from '@sm/i18n';
import type { FieldMeta, ObjectMeta } from '@sm/metadata';
import { fieldAccess, objectAccess } from '@sm/permissions';
import type { RecordContext } from '@sm/records';
import { errors } from '@sm/server-kit';
import type { z } from 'zod';

import { isWritable } from '../metadata/metadata.service.js';
import { RecordsService } from './records.service.js';

type Page = z.infer<typeof RecordPageDto>;
type History = z.infer<typeof FieldHistoryDto>;
type Translate = (key: string, values?: Record<string, unknown>) => string;

/** Lookups that never make a related list: platform-maintained, or conversion bookkeeping. */
const NOT_RELATED = /^(owner_id|created_by|updated_by|converted_.*|record_type_id)$/;
const MAX_RELATED_COLUMNS = 4;
const HISTORY_PAGE = 50;

interface SectionInput {
  key: string;
  label?: string | null;
  labelKey?: string | null;
  columns: 1 | 2;
  fields: { field: string; required?: boolean; readOnly?: boolean }[];
}
interface RelatedInput {
  object: string;
  field: string;
  columns: string[];
  sort?: { field: string; direction: 'asc' | 'desc' };
}
interface PathStep {
  keyFields?: string[];
  guidance?: string;
}

const isString = (v: unknown): v is string => typeof v === 'string';

/**
 * The record page (§9.11 T2): one read for the record and everything its page shows, cut down to
 * what the caller may see, and its FLS-masked field history.
 */
@Injectable()
export class RecordPageService {
  constructor(private readonly records: RecordsService) {}

  private object(ctx: RecordContext, name: string): ObjectMeta {
    const object = ctx.metadata.object(name);
    if (!object || !objectAccess(ctx.permissions, name).read) throw errors.notFound('Object');
    return object;
  }

  private readable(ctx: RecordContext, object: string, field: FieldMeta | undefined): boolean {
    return Boolean(field && fieldAccess(ctx.permissions, object, field.apiName, field).read);
  }

  private relatedLists(
    ctx: RecordContext,
    object: ObjectMeta,
    configured: RelatedInput[],
    t: Translate,
  ): Page['layout']['relatedLists'] {
    const label = (o: ObjectMeta) =>
      o.label.plural ?? (o.labelKey ? t(o.labelKey.plural) : o.apiName);
    // A layout without related lists gets one per lookup pointing at this object.
    const specs: RelatedInput[] = configured.length
      ? configured
      : ctx.metadata.metadata.objects.flatMap((child) =>
          child.fields
            .filter(
              (f) =>
                (f.type === 'lookup' || f.type === 'master_detail') &&
                f.referenceTo.includes(object.apiName) &&
                !f.system &&
                !NOT_RELATED.test(f.apiName),
            )
            .map((f) => ({
              object: child.apiName,
              field: f.apiName,
              columns: [
                ...new Set([...ctx.metadata.nameFields(child.apiName), ...child.compactFields]),
              ].filter((c) => c !== f.apiName),
            })),
        );
    return specs.flatMap((spec) => {
      const child = ctx.metadata.object(spec.object);
      if (!child || !objectAccess(ctx.permissions, child.apiName).read) return [];
      const link = child.fields.find((f) => f.apiName === spec.field);
      if (!this.readable(ctx, child.apiName, link)) return [];
      const columns = spec.columns
        .filter((c) =>
          this.readable(
            ctx,
            child.apiName,
            child.fields.find((f) => f.apiName === c),
          ),
        )
        .slice(0, configured.length ? 10 : MAX_RELATED_COLUMNS);
      const canCreate =
        objectAccess(ctx.permissions, child.apiName).create &&
        Boolean(
          link &&
          isWritable(link) &&
          fieldAccess(ctx.permissions, child.apiName, link.apiName, link).edit,
        );
      return [
        {
          object: child.apiName,
          field: spec.field,
          label: label(child),
          columns,
          sort: spec.sort ?? null,
          canCreate,
        },
      ];
    });
  }

  async page(
    tx: TenantTransaction,
    ctx: RecordContext,
    objectName: string,
    id: string,
    locale: string,
  ): Promise<Page> {
    const object = this.object(ctx, objectName);
    const t = serverTranslator(locale) as unknown as Translate;
    const field = (name: string) => object.fields.find((f) => f.apiName === name);
    const canRead = (name: string) => this.readable(ctx, object.apiName, field(name));

    // The record type decides the layout and the path; read it first (404 if not visible).
    const head = await this.records.get(
      tx,
      ctx,
      object.apiName,
      id,
      canRead('record_type_id') ? 'record_type_id' : 'id',
    );
    const rtValue = head['record_type_id'];
    const recordTypeId =
      (rtValue && typeof rtValue === 'object' && 'id' in rtValue && isString(rtValue.id)
        ? rtValue.id
        : isString(rtValue)
          ? rtValue
          : null) ??
      ctx.metadata.defaultRecordType(object.apiName)?.id ??
      null;

    const user = await tx.prisma.user.findUnique({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id: ctx.userId } },
      select: { profileId: true },
    });
    const layout = ctx.metadata.layoutFor(object.apiName, user?.profileId ?? null, recordTypeId);
    const sections = ((layout?.sections ?? []) as SectionInput[])
      .map((s) => ({
        key: s.key,
        label: s.label ?? (s.labelKey ? t(s.labelKey) : null),
        columns: s.columns,
        fields: s.fields
          .filter((f) => canRead(f.field))
          .map((f) => ({
            field: f.field,
            required: Boolean(f.required) || Boolean(field(f.field)?.required),
            readOnly: Boolean(f.readOnly),
          })),
      }))
      .filter((s) => s.fields.length > 0);
    const compactFields = object.compactFields.filter(canRead);

    // The path: the record type's active path setting, its picklist values in order.
    const setting = object.paths.find((p) => p.recordTypeId === recordTypeId && p.active);
    const steps = (setting?.steps ?? {}) as Record<string, PathStep>;
    const path =
      setting && canRead(setting.field)
        ? {
            field: setting.field,
            stages: ctx.metadata
              .picklistValues(object.apiName, setting.field, recordTypeId)
              .map((v) => ({
                value: v.apiValue,
                label: v.label ?? (v.labelKey ? t(v.labelKey) : v.apiValue),
                category: v.category,
                keyFields: (steps[v.apiValue]?.keyFields ?? []).filter(canRead),
                guidance: steps[v.apiValue]?.guidance ?? null,
              })),
          }
        : null;

    const wanted = new Set<string>([
      ...ctx.metadata.nameFields(object.apiName),
      ...sections.flatMap((s) => s.fields.map((f) => f.field)),
      ...compactFields,
      ...(path ? [path.field, ...path.stages.flatMap((s) => s.keyFields)] : []),
      ...(canRead('owner_id') ? ['owner_id'] : []),
    ]);
    const fields = [...wanted].filter(canRead);
    const record = fields.length
      ? await this.records.get(tx, ctx, object.apiName, id, fields.join(','))
      : head;

    return {
      record,
      recordTypeId,
      layout: {
        id: layout?.id ?? null,
        sections,
        relatedLists: this.relatedLists(
          ctx,
          object,
          (layout?.relatedLists ?? []) as RelatedInput[],
          t,
        ),
      },
      compactFields,
      path,
    };
  }

  async history(
    tx: TenantTransaction,
    ctx: RecordContext,
    objectName: string,
    id: string,
    query: { limit?: number | undefined; cursor?: string | undefined },
  ): Promise<{ items: History[]; nextCursor: string | null }> {
    const object = this.object(ctx, objectName);
    await this.records.get(tx, ctx, object.apiName, id, 'id');
    // FLS masks history: changes to fields the caller cannot read are left out entirely.
    const readable = object.fields
      .filter((f) => this.readable(ctx, object.apiName, f))
      .map((f) => f.apiName);
    const limit = query.limit ?? HISTORY_PAGE;
    const [at, after] = query.cursor ? query.cursor.split('|') : [];
    const before = at ? new Date(at) : null;
    if (before && (Number.isNaN(before.getTime()) || !after))
      throw errors.validation([{ field: 'cursor', code: 'invalid', message: 'Invalid cursor' }]);
    const rows = await tx.prisma.fieldHistory.findMany({
      where: {
        object: object.apiName,
        recordId: id,
        field: { in: readable },
        ...(before && after
          ? {
              OR: [{ changedAt: { lt: before } }, { changedAt: before, id: { lt: after } }],
            }
          : {}),
      },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const userIds = [...new Set(page.map((r) => r.changedBy).filter(isString))];
    const users = new Map(
      (
        await tx.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true },
        })
      ).map((u) => [u.id, u.name]),
    );
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        id: r.id,
        field: r.field,
        oldValue: r.oldValue ?? null,
        newValue: r.newValue ?? null,
        changedAt: r.changedAt.toISOString(),
        changedBy:
          r.changedBy && users.has(r.changedBy)
            ? { id: r.changedBy, name: users.get(r.changedBy) ?? '' }
            : null,
      })),
      nextCursor: rows.length > limit && last ? `${last.changedAt.toISOString()}|${last.id}` : null,
    };
  }
}
