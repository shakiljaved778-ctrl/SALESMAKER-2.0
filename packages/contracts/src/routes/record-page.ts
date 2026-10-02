import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { Uuid } from '../primitives.js';
import { ObjectParam, RecordDto, RecordParam } from './records.js';

/*
 * The record page (§9.11 T2) in one read: the record with every field its page layout, compact
 * layout and path need, the layout itself (sections, related lists), and the path — all already
 * cut down to what the caller may see. Field history is paged separately and masked by FLS.
 */

export const RecordPageSectionDto = z.object({
  key: z.string(),
  /** Translated section heading; null for an untitled section. */
  label: z.string().nullable(),
  columns: z.union([z.literal(1), z.literal(2)]),
  fields: z.array(z.object({ field: z.string(), required: z.boolean(), readOnly: z.boolean() })),
});

export const RecordPageRelatedListDto = z.object({
  /** The child object and its lookup field pointing at this record. */
  object: z.string(),
  field: z.string(),
  label: z.string(),
  columns: z.array(z.string()),
  sort: z.object({ field: z.string(), direction: z.enum(['asc', 'desc']) }).nullable(),
  canCreate: z.boolean(),
});

export const RecordPathDto = z.object({
  field: z.string(),
  stages: z.array(
    z.object({
      value: z.string(),
      label: z.string(),
      category: z.string().nullable(),
      keyFields: z.array(z.string()),
      guidance: z.string().nullable(),
    }),
  ),
});

export const RecordPageDto = z
  .object({
    record: RecordDto,
    recordTypeId: Uuid.nullable(),
    layout: z.object({
      id: Uuid.nullable(),
      sections: z.array(RecordPageSectionDto),
      relatedLists: z.array(RecordPageRelatedListDto),
    }),
    compactFields: z.array(z.string()),
    path: RecordPathDto.nullable(),
  })
  .meta({ id: 'RecordPage' });

export const FieldHistoryDto = z
  .object({
    id: Uuid,
    field: z.string(),
    oldValue: z.unknown(),
    newValue: z.unknown(),
    changedAt: z.string(),
    changedBy: z.object({ id: Uuid, name: z.string() }).nullable(),
  })
  .meta({ id: 'FieldHistory' });

export const FieldHistoryQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().max(200).optional(),
  })
  .strict();

export const CreateLayoutDto = z
  .object({
    recordTypeId: Uuid.nullable(),
    layoutId: Uuid.nullable(),
    sections: z.array(RecordPageSectionDto),
  })
  .meta({ id: 'CreateLayout' });

export const CreateLayoutQuery = z.object({ recordTypeId: Uuid.optional() }).strict();

const errorsOf = { 404: { description: 'No such object or record visible to the caller' } };
const route = (spec: Omit<Parameters<typeof defineRoute>[0], 'tags' | 'auth' | 'visibility'>) =>
  defineRoute({ ...spec, tags: ['records'], auth: 'session', visibility: 'internal' });

export const recordPageRoutes = {
  getCreateLayout: route({
    method: 'get',
    path: '/v1/objects/{object}/layout',
    operationId: 'getCreateLayout',
    summary: 'The page layout a new record of a record type is created with, as the caller sees it',
    request: { params: ObjectParam, query: CreateLayoutQuery },
    responses: { 200: { description: 'The layout', body: CreateLayoutDto }, ...errorsOf },
  }),
  getRecordPage: route({
    method: 'get',
    path: '/v1/records/{object}/{id}/page',
    operationId: 'getRecordPage',
    summary: 'A record with its page layout, compact fields and path, as the caller sees them',
    request: { params: RecordParam },
    responses: { 200: { description: 'The record page', body: RecordPageDto }, ...errorsOf },
  }),
  getFieldHistory: route({
    method: 'get',
    path: '/v1/records/{object}/{id}/history',
    operationId: 'getFieldHistory',
    summary: 'Tracked field changes, newest first, without fields the caller cannot read',
    request: { params: RecordParam, query: FieldHistoryQuery },
    responses: {
      200: {
        description: 'A page of changes',
        body: z.object({ items: z.array(FieldHistoryDto), nextCursor: z.string().nullable() }),
      },
      ...errorsOf,
    },
  }),
};
