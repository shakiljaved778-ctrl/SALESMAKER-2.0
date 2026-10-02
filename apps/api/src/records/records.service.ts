import { Injectable } from '@nestjs/common';
import type {
  DescribedObjectDto,
  JobDto,
  MassActionRequest,
  ObjectSummaryDto,
  PutTeamMemberRequest,
  QueryRequest,
  RecycleBinItemDto,
  TeamMemberDto,
  WriteFieldsRequest,
} from '@sm/contracts';
import { Money } from '@sm/contracts';
import type { TenantTransaction } from '@sm/db';
import type { ObjectMeta } from '@sm/metadata';
import { fieldAccess, objectAccess } from '@sm/permissions';
import { runQuery, type FilterNode, type QueryRecord } from '@sm/query-engine';
import {
  createRecord,
  deleteRecord,
  listTeam,
  previewMassAction,
  removeTeamMember,
  setTeamMember,
  startMassAction,
  undeleteRecord,
  updateRecord,
  type RecordContext,
  type WriteInput,
} from '@sm/records';
import { errors } from '@sm/server-kit';
import { sql } from 'kysely';
import type { z } from 'zod';

import { MetadataService } from '../metadata/metadata.service.js';
import { translating } from './record-errors.js';

type Out = Record<string, unknown> & { id: string; version: number };
type Page = { items: Out[]; nextCursor: string | null };

/** SMQ caps a projection at 100 fields (§3.8). */
const MAX_FIELDS = 100;
const FILTER_KEY = /^filter\[([a-z][a-z0-9_.]*)\](?:\[([a-z_]+)\])?$/;
const FILTER_OPS = new Set([
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'starts_with',
  'in',
  'not_in',
  'is_null',
  'is_not_null',
]);

const invalid = (field: string, code: string, message: string) =>
  errors.validation([{ field, code, message }]);

/**
 * The records API (§10.1) over RecordService (writes) and the Query Engine (reads): every read
 * applies sharing and FLS, every write runs the full pipeline as the caller (golden rules 2, 3).
 */
@Injectable()
export class RecordsService {
  constructor(private readonly metadata: MetadataService) {}

  private object(ctx: RecordContext, name: string): ObjectMeta {
    const object = ctx.metadata.object(name);
    if (!object || !objectAccess(ctx.permissions, name).read) throw errors.notFound('Object');
    return object;
  }

  /** The fields a caller may read, for a default projection. */
  private readable(ctx: RecordContext, object: ObjectMeta): string[] {
    return object.fields
      .filter(
        (f) =>
          f.apiName !== 'id' && fieldAccess(ctx.permissions, object.apiName, f.apiName, f).read,
      )
      .map((f) => f.apiName)
      .slice(0, MAX_FIELDS);
  }

  private fieldsOf(ctx: RecordContext, object: ObjectMeta, fields: string | undefined): string[] {
    if (!fields) return this.readable(ctx, object);
    const list = fields
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
    if (list.length === 0 || list.length > MAX_FIELDS)
      throw invalid('fields', 'invalid', `List between 1 and ${String(MAX_FIELDS)} fields`);
    return list;
  }

  /** Money fields as Money; everything else as the Query Engine returns it. */
  private present(ctx: RecordContext, object: ObjectMeta, record: QueryRecord): Out {
    const out: Record<string, unknown> = {};
    const currency = (record['currencyCode'] as string | null | undefined) ?? ctx.corporateCurrency;
    for (const [key, value] of Object.entries(record)) {
      if (key === 'currencyCode') continue;
      const field = object.fields.find((f) => f.apiName === key);
      out[key] =
        field?.type === 'currency' && typeof value === 'string'
          ? { amount: value, currency }
          : value;
    }
    return out as Out;
  }

  /** Accept Money for money fields; they must agree with each other and with `currencyCode`. */
  private input(object: ObjectMeta, body: z.infer<typeof WriteFieldsRequest>): WriteInput {
    const fields: Record<string, unknown> = {};
    let currency = body.currencyCode;
    for (const [name, value] of Object.entries(body.fields)) {
      const field = object.fields.find((f) => f.apiName === name);
      const money = field?.type === 'currency' ? Money.safeParse(value) : null;
      if (money?.success) {
        if (currency && currency !== money.data.currency)
          throw invalid(name, 'currency_mismatch', 'Money fields must share one currency');
        currency = money.data.currency;
        fields[name] = money.data.amount;
      } else fields[name] = value;
    }
    return { fields, ...(currency ? { currencyCode: currency } : {}) };
  }

  private async read(
    tx: TenantTransaction,
    ctx: RecordContext,
    object: ObjectMeta,
    id: string,
    fields?: string,
  ): Promise<Out | null> {
    const page = await translating(() =>
      runQuery(
        tx.kysely,
        {
          object: object.apiName,
          fields: this.fieldsOf(ctx, object, fields),
          where: { field: 'id', op: 'eq', value: id },
          limit: 1,
        },
        { ...ctx, maxLimit: 200, recordMeta: true },
      ),
    );
    const record = page.records[0];
    return record ? this.present(ctx, object, record) : null;
  }

  // ── Objects ─────────────────────────────────────────────────────────────────────────────────
  listObjects(ctx: RecordContext, locale: string): { items: z.infer<typeof ObjectSummaryDto>[] } {
    const items = ctx.metadata.metadata.objects.flatMap((o) => {
      const d = this.metadata.describe(ctx.metadata, o.apiName, ctx.permissions, locale);
      return d
        ? [
            {
              name: d.name,
              label: d.label,
              labelPlural: d.labelPlural,
              custom: d.custom,
              icon: d.icon,
              color: d.color,
              access: d.access,
            },
          ]
        : [];
    });
    return { items: items.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  describe(ctx: RecordContext, object: string, locale: string): z.infer<typeof DescribedObjectDto> {
    const d = this.metadata.describe(ctx.metadata, object, ctx.permissions, locale);
    if (!d) throw errors.notFound('Object');
    return { ...d, nameFields: [...d.nameFields] };
  }

  // ── Reads ───────────────────────────────────────────────────────────────────────────────────
  async list(
    tx: TenantTransaction,
    ctx: RecordContext,
    objectName: string,
    query: Record<string, unknown>,
  ): Promise<Page> {
    const object = this.object(ctx, objectName);
    const where = this.filters(object, query);
    const orderBy = this.sort(query['sort']);
    const page = await translating(() =>
      runQuery(
        tx.kysely,
        {
          object: object.apiName,
          fields: this.fieldsOf(ctx, object, query['fields'] as string | undefined),
          ...(where ? { where } : {}),
          ...(orderBy.length ? { orderBy } : {}),
          limit: (query['limit'] as number | undefined) ?? 50,
          ...(typeof query['cursor'] === 'string' ? { cursor: query['cursor'] } : {}),
        },
        { ...ctx, maxLimit: 200, recordMeta: true },
      ),
    );
    return {
      items: page.records.map((r) => this.present(ctx, object, r)),
      nextCursor: page.nextCursor,
    };
  }

  /** `sort=-amount,name`: a leading minus sorts descending. */
  private sort(sort: unknown): { field: string; direction: 'asc' | 'desc' }[] {
    if (typeof sort !== 'string' || sort === '') return [];
    const keys = sort.split(',').map((s) => s.trim());
    if (keys.length > 3) throw invalid('sort', 'invalid', 'Sort by at most 3 fields');
    return keys.map((k) =>
      k.startsWith('-') ? { field: k.slice(1), direction: 'desc' } : { field: k, direction: 'asc' },
    );
  }

  /** `filter[field][op]=value` (§10.1); `in` takes a comma list; checkbox values are booleans. */
  private filters(object: ObjectMeta, query: Record<string, unknown>): FilterNode | undefined {
    const conditions: FilterNode[] = [];
    for (const [key, raw] of Object.entries(query)) {
      const match = FILTER_KEY.exec(key);
      if (!match) continue;
      const field = match[1] ?? '';
      const op = match[2] ?? 'eq';
      if (!FILTER_OPS.has(op)) throw invalid(key, 'invalid_filter', `Unknown operator ${op}`);
      const text = Array.isArray(raw) ? String(raw.at(-1)) : String(raw);
      const type = object.fields.find((f) => f.apiName === field)?.type;
      const scalar = (v: string) => (type === 'checkbox' ? v === 'true' : v);
      if (op === 'is_null' || op === 'is_not_null') conditions.push({ field, op });
      else if (op === 'in' || op === 'not_in')
        conditions.push({ field, op, value: text.split(',').map(scalar) });
      else conditions.push({ field, op, value: scalar(text) } as FilterNode);
    }
    if (conditions.length === 0) return undefined;
    return conditions.length === 1 ? conditions[0] : { and: conditions };
  }

  async get(
    tx: TenantTransaction,
    ctx: RecordContext,
    objectName: string,
    id: string,
    fields?: string,
  ): Promise<Out> {
    const record = await this.read(tx, ctx, this.object(ctx, objectName), id, fields);
    if (!record) throw errors.notFound('Record');
    return record;
  }

  async query(
    tx: TenantTransaction,
    ctx: RecordContext,
    body: z.infer<typeof QueryRequest>,
  ): Promise<Page> {
    const object = this.object(ctx, body.object);
    const page = await translating(() =>
      runQuery(tx.kysely, body, { ...ctx, maxLimit: 2000, recordMeta: true }),
    );
    return {
      items: page.records.map((r) => this.present(ctx, object, r)),
      nextCursor: page.nextCursor,
    };
  }

  // ── Writes ──────────────────────────────────────────────────────────────────────────────────
  /** The record after a write, as the writer may see it (FLS-stripped by the Query Engine). */
  private async after(
    tx: TenantTransaction,
    ctx: RecordContext,
    object: ObjectMeta,
    id: string,
    version: number,
  ): Promise<Out> {
    return (await this.read(tx, ctx, object, id)) ?? { id, version };
  }

  async create(
    tx: TenantTransaction,
    ctx: RecordContext,
    objectName: string,
    body: z.infer<typeof WriteFieldsRequest>,
  ): Promise<Out> {
    const object = this.object(ctx, objectName);
    const done = await translating(() =>
      createRecord(tx, ctx, object.apiName, this.input(object, body)),
    );
    return this.after(tx, ctx, object, done.id, done.version);
  }

  async update(
    tx: TenantTransaction,
    ctx: RecordContext,
    objectName: string,
    id: string,
    body: z.infer<typeof WriteFieldsRequest>,
    version: number | null,
  ): Promise<Out> {
    const object = this.object(ctx, objectName);
    const done = await translating(() =>
      updateRecord(tx, ctx, object.apiName, id, this.input(object, body), version),
    );
    return this.after(tx, ctx, object, done.id, done.version);
  }

  async remove(tx: TenantTransaction, ctx: RecordContext, objectName: string, id: string) {
    const object = this.object(ctx, objectName);
    await translating(() => deleteRecord(tx, ctx, object.apiName, id));
  }

  /**
   * Upsert by the standard `external_id` (unique per object). An existing record the caller
   * cannot see is not found, as with any other update.
   */
  async upsert(
    tx: TenantTransaction,
    ctx: RecordContext,
    objectName: string,
    externalId: string,
    body: z.infer<typeof WriteFieldsRequest>,
  ): Promise<{ created: boolean; record: Out }> {
    const object = this.object(ctx, objectName);
    if (!object.fields.some((f) => f.apiName === 'external_id'))
      throw invalid('externalId', 'not_supported', 'This object has no external id');
    if ('external_id' in body.fields && body.fields['external_id'] !== externalId)
      throw invalid('external_id', 'mismatch', 'The external id is given by the URL');
    const found = await sql<{ id: string }>`
      SELECT id FROM ${sql.table(object.table)}
       WHERE tenant_id = ${tx.context.tenantId}::uuid AND external_id = ${externalId}
         AND deleted_at IS NULL`.execute(tx.kysely);
    const existing = found.rows[0]?.id;
    const input = { ...body, fields: { ...body.fields, external_id: externalId } };
    if (existing)
      return {
        created: false,
        record: await this.update(tx, ctx, objectName, existing, input, null),
      };
    return { created: true, record: await this.create(tx, ctx, objectName, input) };
  }

  // ── Mass actions and jobs ───────────────────────────────────────────────────────────────────
  async previewMass(
    tx: TenantTransaction,
    ctx: RecordContext,
    objectName: string,
    body: z.infer<typeof MassActionRequest>,
  ) {
    this.object(ctx, objectName);
    return translating(() =>
      previewMassAction(tx, ctx, {
        object: objectName,
        ...(body.ids ? { ids: body.ids } : {}),
        ...(body.where ? { where: body.where as FilterNode } : {}),
        action: body.action,
      }),
    );
  }

  async startMass(
    tx: TenantTransaction,
    ctx: RecordContext,
    objectName: string,
    body: z.infer<typeof MassActionRequest>,
  ): Promise<z.infer<typeof JobDto>> {
    this.object(ctx, objectName);
    const { jobRunId } = await translating(() =>
      startMassAction(tx, ctx, { object: objectName, ...body }),
    );
    return this.job(tx, ctx, jobRunId);
  }

  /** A job the caller started; anyone else's is not found. */
  async job(
    tx: TenantTransaction,
    ctx: RecordContext,
    id: string,
  ): Promise<z.infer<typeof JobDto>> {
    const run = await tx.prisma.jobRun.findFirst({ where: { id, createdBy: ctx.userId } });
    if (!run) throw errors.notFound('Job');
    return {
      id: run.id,
      kind: run.kind,
      status: run.status,
      done: run.done,
      total: run.total,
      failed: run.failed,
      result: run.result ?? null,
      error: run.error,
      createdAt: run.createdAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    };
  }

  // ── Teams ───────────────────────────────────────────────────────────────────────────────────
  async team(
    tx: TenantTransaction,
    ctx: RecordContext,
    object: 'account' | 'opportunity',
    id: string,
  ): Promise<{ items: z.infer<typeof TeamMemberDto>[] }> {
    return { items: await translating(() => listTeam(tx, ctx, object, id)) };
  }

  async putTeamMember(
    tx: TenantTransaction,
    ctx: RecordContext,
    object: 'account' | 'opportunity',
    id: string,
    userId: string,
    body: z.infer<typeof PutTeamMemberRequest>,
  ) {
    await translating(() =>
      setTeamMember(tx, ctx, object, id, {
        userId,
        access: body.access,
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.opportunityAccess !== undefined
          ? { opportunityAccess: body.opportunityAccess }
          : {}),
      }),
    );
    return this.team(tx, ctx, object, id);
  }

  async removeTeamMember(
    tx: TenantTransaction,
    ctx: RecordContext,
    object: 'account' | 'opportunity',
    id: string,
    userId: string,
  ) {
    await translating(() => removeTeamMember(tx, ctx, object, id, userId));
  }

  // ── Recycle bin ─────────────────────────────────────────────────────────────────────────────
  async recycleBin(
    tx: TenantTransaction,
    ctx: RecordContext,
  ): Promise<{ items: z.infer<typeof RecycleBinItemDto>[] }> {
    const all = ctx.permissions.system.has('modify_all_data');
    const rows = await tx.prisma.recycleBinItem.findMany({
      where: { cascadeOf: null, ...(all ? {} : { deletedBy: ctx.userId }) },
      orderBy: { deletedAt: 'desc' },
      take: 500,
    });
    return {
      items: rows
        .filter((r) => objectAccess(ctx.permissions, r.object).read)
        .map((r) => ({
          id: r.id,
          object: r.object,
          recordId: r.recordId,
          name: r.name,
          deletedAt: r.deletedAt.toISOString(),
          deletedBy: r.deletedBy,
          purgeAfter: r.purgeAfter.toISOString(),
        })),
    };
  }

  async restore(tx: TenantTransaction, ctx: RecordContext, objectName: string, id: string) {
    this.object(ctx, objectName);
    return translating(() => undeleteRecord(tx, ctx, objectName, id));
  }
}
