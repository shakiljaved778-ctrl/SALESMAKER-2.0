import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { Uuid } from '../primitives.js';
import { ObjectApiName } from './access.js';
import { IfMatchHeaders, RecordDto } from './records.js';

/*
 * List views (§5.6, §9.11 T1): saved filter trees, columns and sort per object, shared privately,
 * with public groups or with everyone; plus a pinned default per user. Running a view goes through
 * the Query Engine as the caller, so sharing and FLS apply to every row and column.
 */

const FieldPath = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}(\.[a-z][a-z0-9_]{0,62}){0,3}$/, 'Must be a field or path');

export const ListViewVisibility = z.enum(['PRIVATE', 'GROUPS', 'ALL']);
export const ListViewSort = z.object({
  field: FieldPath,
  direction: z.enum(['asc', 'desc']),
});

export const ListViewDto = z
  .object({
    id: Uuid,
    name: z.string(),
    /** `all`, `mine` or `recent` for the views every object starts with; null for saved views. */
    systemKey: z.string().nullable(),
    visibility: ListViewVisibility,
    groupIds: z.array(Uuid),
    /** Filter tree (SMQ `where`); `$me` is the viewer. */
    filter: z.unknown().nullable(),
    columns: z.array(z.string()),
    sort: z.array(ListViewSort),
    ownerId: Uuid.nullable(),
    version: z.number().int(),
    /** Whether the caller may change or delete it. */
    editable: z.boolean(),
  })
  .meta({ id: 'ListView' });

export const ListViewsDto = z
  .object({ items: z.array(ListViewDto), pinnedId: Uuid.nullable() })
  .meta({ id: 'ListViews' });

export const CreateListViewRequest = z
  .object({
    name: z.string().trim().min(1).max(80),
    visibility: ListViewVisibility.default('PRIVATE'),
    groupIds: z.array(Uuid).max(50).default([]),
    filter: z.unknown().nullable().default(null),
    columns: z.array(FieldPath).min(1).max(30),
    sort: z.array(ListViewSort).max(3).default([]),
  })
  .strict()
  .meta({ id: 'CreateListView' });

export const UpdateListViewRequest = z
  .object({
    name: z.string().trim().min(1).max(80),
    visibility: ListViewVisibility,
    groupIds: z.array(Uuid).max(50),
    filter: z.unknown().nullable(),
    columns: z.array(FieldPath).min(1).max(30),
    sort: z.array(ListViewSort).max(3),
  })
  .partial()
  .strict()
  .meta({ id: 'UpdateListView' });

/** Running a view: the saved filter AND the quick filters, optionally re-sorted or re-columned. */
export const RunListViewRequest = z
  .object({
    /** Quick filters (SMQ `where`), ANDed with the view's own filter. */
    where: z.unknown().optional(),
    /** Matches the name field (contains). */
    search: z.string().trim().max(100).optional(),
    /** Overrides the view's sort for this run (a column header click). */
    sort: z.array(ListViewSort).max(3).optional(),
    /** Overrides the view's columns for this run (column chooser before saving). */
    columns: z.array(FieldPath).min(1).max(30).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().max(4000).optional(),
    /** Also count all matching records (capped). Only the first page needs it. */
    count: z.boolean().default(false),
  })
  .strict()
  .meta({ id: 'RunListView' });

export const ListViewResultsDto = z
  .object({
    items: z.array(RecordDto),
    nextCursor: z.string().nullable(),
    /** The columns actually returned: the view's, minus fields the caller cannot read. */
    columns: z.array(z.string()),
    count: z.object({ count: z.number().int(), capped: z.boolean() }).optional(),
  })
  .meta({ id: 'ListViewResults' });

export const ListViewParam = z.object({ object: ObjectApiName, id: Uuid });
const ObjectOnly = z.object({ object: ObjectApiName });

const errorsOf = {
  400: { description: 'Invalid view (unknown field, bad filter or sort)' },
  403: { description: 'Sharing a view with groups or everyone needs customize_application' },
  404: { description: 'No such object or view visible to the caller' },
};
const route = (spec: Omit<Parameters<typeof defineRoute>[0], 'tags' | 'auth' | 'visibility'>) =>
  defineRoute({ ...spec, tags: ['records'], auth: 'session', visibility: 'internal' });

export const listViewRoutes = {
  listListViews: route({
    method: 'get',
    path: '/v1/objects/{object}/list-views',
    operationId: 'listListViews',
    summary: 'List views the caller can use for an object, and their pinned default',
    request: { params: ObjectOnly },
    responses: { 200: { description: 'Views', body: ListViewsDto }, ...errorsOf },
  }),
  createListView: route({
    method: 'post',
    path: '/v1/objects/{object}/list-views',
    operationId: 'createListView',
    summary: 'Save a list view',
    request: { params: ObjectOnly, body: CreateListViewRequest },
    responses: { 201: { description: 'The view', body: ListViewDto }, ...errorsOf },
  }),
  updateListView: route({
    method: 'patch',
    path: '/v1/objects/{object}/list-views/{id}',
    operationId: 'updateListView',
    summary: 'Change a list view',
    request: { params: ListViewParam, headers: IfMatchHeaders, body: UpdateListViewRequest },
    responses: {
      200: { description: 'The view', body: ListViewDto },
      ...errorsOf,
      409: { description: 'The view changed since the given version' },
    },
  }),
  deleteListView: route({
    method: 'delete',
    path: '/v1/objects/{object}/list-views/{id}',
    operationId: 'deleteListView',
    summary: 'Delete a saved list view (the views every object starts with stay)',
    request: { params: ListViewParam },
    responses: { 204: { description: 'Deleted' }, ...errorsOf },
  }),
  pinListView: route({
    method: 'put',
    path: '/v1/objects/{object}/list-views/{id}/pin',
    operationId: 'pinListView',
    summary: 'Make a view the caller’s default for the object',
    request: { params: ListViewParam },
    responses: { 204: { description: 'Pinned' }, ...errorsOf },
  }),
  runListView: route({
    method: 'post',
    path: '/v1/objects/{object}/list-views/{id}/results',
    operationId: 'runListView',
    summary: 'Records in a view, with quick filters, paged by cursor',
    request: { params: ListViewParam, body: RunListViewRequest },
    responses: { 200: { description: 'A page of records', body: ListViewResultsDto }, ...errorsOf },
  }),
};
