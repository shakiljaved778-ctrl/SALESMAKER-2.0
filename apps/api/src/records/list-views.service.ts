import { Injectable } from '@nestjs/common';
import type {
  CreateListViewRequest,
  ListViewDto,
  ListViewResultsDto,
  RunListViewRequest,
  UpdateListViewRequest,
} from '@sm/contracts';
import { audit, type TenantTransaction } from '@sm/db';
import type { ObjectMeta } from '@sm/metadata';
import { fieldAccess, objectAccess } from '@sm/permissions';
import { compileQuery, countQuery, type FilterNode } from '@sm/query-engine';
import type { RecordContext } from '@sm/records';
import { errors } from '@sm/server-kit';
import { sql } from 'kysely';
import type { z } from 'zod';

import { invalid, staleVersion } from '../setup/common.js';
import { translating } from './record-errors.js';
import { RecordsService } from './records.service.js';

type View = z.infer<typeof ListViewDto>;
type Sort = View['sort'];
type Row = Awaited<ReturnType<TenantTransaction['prisma']['listView']['findFirstOrThrow']>>;

const SHARED_PERMISSION = 'customize_application';

/**
 * List views (§5.6, §9.11 T1). Anyone who can read an object keeps private views; sharing a view
 * with public groups or everyone, and changing the views every object starts with, needs
 * customize_application (shared views are audited). Views are checked by compiling them as their
 * author, and run as the viewer, so sharing and FLS apply to every row and column.
 */
@Injectable()
export class ListViewsService {
  constructor(private readonly records: RecordsService) {}

  private object(ctx: RecordContext, name: string): ObjectMeta {
    const object = ctx.metadata.object(name);
    if (!object || !objectAccess(ctx.permissions, name).read) throw errors.notFound('Object');
    return object;
  }

  private canShare(ctx: RecordContext): boolean {
    return ctx.permissions.system.has(SHARED_PERMISSION);
  }

  private visible(ctx: RecordContext, row: Row): boolean {
    if (row.ownerId === ctx.userId || row.visibility === 'ALL') return true;
    if (row.visibility !== 'GROUPS') return false;
    const mine = new Set(ctx.sharing.principals.groupIds);
    return row.groupIds.some((g) => mine.has(g));
  }

  private editable(ctx: RecordContext, row: Row): boolean {
    if (row.systemKey !== null || row.visibility !== 'PRIVATE') return this.canShare(ctx);
    return row.ownerId === ctx.userId;
  }

  private dto(ctx: RecordContext, row: Row): View {
    return {
      id: row.id,
      name: row.name,
      systemKey: row.systemKey,
      visibility: row.visibility,
      groupIds: row.groupIds,
      filter: row.filter ?? null,
      columns: row.columns,
      sort: (row.sort ?? []) as Sort,
      ownerId: row.ownerId,
      version: row.version,
      editable: this.editable(ctx, row),
    };
  }

  private async find(tx: TenantTransaction, ctx: RecordContext, object: ObjectMeta, id: string) {
    const row = await tx.prisma.listView.findFirst({ where: { id, objectId: object.id } });
    if (!row || !this.visible(ctx, row)) throw errors.notFound('List view');
    return row;
  }

  /** Compile the view as its author: unknown or unreadable fields and bad filters are 400s. */
  private async validate(
    tx: TenantTransaction,
    ctx: RecordContext,
    object: ObjectMeta,
    view: {
      filter: unknown;
      columns: string[];
      sort: Sort;
      visibility: View['visibility'];
      groupIds: string[];
    },
  ) {
    await translating(async () => {
      compileQuery(
        {
          object: object.apiName,
          fields: view.columns,
          ...(view.filter ? { where: view.filter } : {}),
          ...(view.sort.length ? { orderBy: view.sort } : {}),
          limit: 1,
        },
        { ...ctx, maxLimit: 200 },
      );
      return Promise.resolve();
    });
    if (view.visibility !== 'PRIVATE' && !this.canShare(ctx)) throw errors.forbidden();
    if (view.visibility === 'GROUPS') {
      if (view.groupIds.length === 0)
        throw invalid('groupIds', 'Choose at least one public group', 'required');
      const found = await tx.prisma.publicGroup.count({ where: { id: { in: view.groupIds } } });
      if (found !== new Set(view.groupIds).size)
        throw invalid('groupIds', 'Choose existing public groups');
    }
  }

  async list(tx: TenantTransaction, ctx: RecordContext, objectName: string) {
    const object = this.object(ctx, objectName);
    const rows = await tx.prisma.listView.findMany({
      where: {
        objectId: object.id,
        OR: [
          { ownerId: ctx.userId },
          { visibility: 'ALL' },
          { visibility: 'GROUPS', groupIds: { hasSome: [...ctx.sharing.principals.groupIds] } },
        ],
      },
    });
    // The views every object starts with come first, in a fixed order; then saved views by name.
    const order = ['all', 'mine', 'recent'];
    rows.sort((a, b) => {
      const ka = a.systemKey ? order.indexOf(a.systemKey) : order.length;
      const kb = b.systemKey ? order.indexOf(b.systemKey) : order.length;
      return ka - kb || a.name.localeCompare(b.name);
    });
    const pin = await tx.prisma.listViewPin.findUnique({
      where: {
        tenantId_userId_objectId: {
          tenantId: tx.context.tenantId,
          userId: ctx.userId,
          objectId: object.id,
        },
      },
    });
    const pinnedId = pin && rows.some((r) => r.id === pin.listViewId) ? pin.listViewId : null;
    return { items: rows.map((r) => this.dto(ctx, r)), pinnedId };
  }

  async create(
    tx: TenantTransaction,
    ctx: RecordContext,
    objectName: string,
    body: z.infer<typeof CreateListViewRequest>,
  ): Promise<View> {
    const object = this.object(ctx, objectName);
    const groupIds = body.visibility === 'GROUPS' ? body.groupIds : [];
    await this.validate(tx, ctx, object, { ...body, groupIds });
    const row = await tx.prisma.listView.create({
      data: {
        tenantId: tx.context.tenantId,
        objectId: object.id,
        name: body.name,
        ownerId: ctx.userId,
        visibility: body.visibility,
        groupIds,
        ...(body.filter ? { filter: body.filter } : {}),
        columns: body.columns,
        sort: body.sort,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    });
    if (row.visibility !== 'PRIVATE')
      await audit.setup(tx, {
        action: 'list_view.created',
        entityType: 'list_view',
        entityId: row.id,
        entityName: row.name,
        after: { object: object.apiName, visibility: row.visibility, groupIds },
      });
    return this.dto(ctx, row);
  }

  async update(
    tx: TenantTransaction,
    ctx: RecordContext,
    objectName: string,
    id: string,
    body: z.infer<typeof UpdateListViewRequest>,
    version: number | null,
  ): Promise<View> {
    const object = this.object(ctx, objectName);
    const row = await this.find(tx, ctx, object, id);
    if (!this.editable(ctx, row)) throw errors.forbidden();
    if (version !== null && version !== row.version) throw staleVersion('list view');
    if (row.systemKey !== null && body.visibility && body.visibility !== row.visibility)
      throw invalid('visibility', 'The views every object starts with stay visible to everyone');
    const next = {
      filter: body.filter === undefined ? (row.filter ?? null) : body.filter,
      columns: body.columns ?? row.columns,
      sort: body.sort ?? ((row.sort ?? []) as Sort),
      visibility: body.visibility ?? row.visibility,
      groupIds:
        (body.visibility ?? row.visibility) === 'GROUPS' ? (body.groupIds ?? row.groupIds) : [],
    };
    await this.validate(tx, ctx, object, next);
    const updated = await tx.prisma.listView.updateMany({
      where: { id, version: row.version },
      data: {
        ...(body.name ? { name: body.name } : {}),
        visibility: next.visibility,
        groupIds: next.groupIds,
        ...(next.filter ? { filter: next.filter } : {}),
        columns: next.columns,
        sort: next.sort,
        updatedBy: ctx.userId,
        version: { increment: 1 },
      },
    });
    if (updated.count === 0) throw staleVersion('list view');
    if (!next.filter && row.filter !== null)
      await sql`UPDATE list_view SET filter = NULL WHERE id = ${id}::uuid`.execute(tx.kysely);
    const saved = await tx.prisma.listView.findFirstOrThrow({ where: { id } });
    if (row.visibility !== 'PRIVATE' || saved.visibility !== 'PRIVATE')
      await audit.setup(tx, {
        action: 'list_view.updated',
        entityType: 'list_view',
        entityId: id,
        entityName: saved.name,
        before: { visibility: row.visibility, groupIds: row.groupIds, columns: row.columns },
        after: { visibility: saved.visibility, groupIds: saved.groupIds, columns: saved.columns },
      });
    return this.dto(ctx, saved);
  }

  async remove(tx: TenantTransaction, ctx: RecordContext, objectName: string, id: string) {
    const object = this.object(ctx, objectName);
    const row = await this.find(tx, ctx, object, id);
    if (!this.editable(ctx, row)) throw errors.forbidden();
    if (row.systemKey !== null) throw errors.conflict('The views every object starts with stay');
    await tx.prisma.listView.delete({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
    });
    if (row.visibility !== 'PRIVATE')
      await audit.setup(tx, {
        action: 'list_view.deleted',
        entityType: 'list_view',
        entityId: id,
        entityName: row.name,
        before: { visibility: row.visibility, groupIds: row.groupIds },
      });
  }

  async pin(tx: TenantTransaction, ctx: RecordContext, objectName: string, id: string) {
    const object = this.object(ctx, objectName);
    await this.find(tx, ctx, object, id);
    const key = { tenantId: tx.context.tenantId, userId: ctx.userId, objectId: object.id };
    await tx.prisma.listViewPin.upsert({
      where: { tenantId_userId_objectId: key },
      create: { ...key, listViewId: id },
      update: { listViewId: id },
    });
  }

  async run(
    tx: TenantTransaction,
    ctx: RecordContext,
    objectName: string,
    id: string,
    body: z.infer<typeof RunListViewRequest>,
  ): Promise<z.infer<typeof ListViewResultsDto>> {
    const object = this.object(ctx, objectName);
    const row = await this.find(tx, ctx, object, id);
    // Columns the viewer cannot read are dropped, not refused: a shared view still works for them.
    const readable = (path: string) => {
      const field = object.fields.find((f) => f.apiName === path.split('.')[0]);
      return Boolean(
        field && fieldAccess(ctx.permissions, object.apiName, field.apiName, field).read,
      );
    };
    const columns = (body.columns ?? row.columns).filter(readable);
    // Every name field (first and last name for people), so the list can show the full name.
    const names = ctx.metadata.nameFields(object.apiName);
    const fields = [...new Set([...names, ...columns])].filter(readable);
    if (fields.length === 0) fields.push('id');
    const conditions: FilterNode[] = [];
    if (row.filter) conditions.push(row.filter as FilterNode);
    if (body.where) conditions.push(body.where as FilterNode);
    if (body.search && readable(object.nameField))
      conditions.push({ field: object.nameField, op: 'contains', value: body.search });
    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : { and: conditions };
    const sort = (body.sort ?? ((row.sort ?? []) as Sort)).filter((s) => readable(s.field));
    const recent = row.systemKey === 'recent';
    const input = {
      object: object.apiName,
      fields,
      ...(where ? { where } : {}),
      ...(sort.length && !recent ? { orderBy: sort } : {}),
      ...(recent ? { scope: 'recent' as const } : {}),
    };
    const page = await this.records.query(tx, ctx, {
      ...input,
      limit: body.limit,
      ...(body.cursor ? { cursor: body.cursor } : {}),
    });
    const count = body.count
      ? await translating(() => countQuery(tx.kysely, input, { ...ctx, maxLimit: 200 }))
      : undefined;
    return { ...page, columns, ...(count ? { count } : {}) };
  }
}
