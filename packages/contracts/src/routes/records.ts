import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { CurrencyCode, Uuid } from '../primitives.js';
import { ObjectApiName } from './access.js';

/*
 * The generic, metadata-driven records API (§10.1). One set of routes serves every object;
 * what a caller sees and may change comes from metadata, object permissions, sharing and FLS.
 * Money travels as `{ amount: "1250.00", currency: "USD" }` with string decimals.
 */

const FieldName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'Must be a field API name');
const FieldPath = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}(\.[a-z][a-z0-9_]{0,62}){0,3}$/, 'Must be a field or path');

// ── Objects and describe ────────────────────────────────────────────────────────────────────
export const ObjectAccessFlags = z.object({
  read: z.boolean(),
  create: z.boolean(),
  edit: z.boolean(),
  delete: z.boolean(),
});

export const ObjectSummaryDto = z
  .object({
    name: z.string(),
    label: z.string(),
    labelPlural: z.string(),
    custom: z.boolean(),
    icon: z.string(),
    color: z.string(),
    access: ObjectAccessFlags,
  })
  .meta({ id: 'ObjectSummary' });

export const DescribedFieldDto = z
  .object({
    name: z.string(),
    label: z.string(),
    type: z.string(),
    custom: z.boolean(),
    required: z.boolean(),
    readable: z.literal(true),
    editable: z.boolean(),
    sortable: z.boolean(),
    searchable: z.boolean(),
    unique: z.boolean(),
    externalId: z.boolean(),
    length: z.number().int().nullable(),
    precision: z.number().int().nullable(),
    scale: z.number().int().nullable(),
    referenceTo: z.array(z.string()),
    helpText: z.string().nullable(),
    picklistValues: z
      .array(
        z.object({
          value: z.string(),
          label: z.string(),
          category: z.string().nullable(),
          default: z.boolean(),
        }),
      )
      .optional(),
  })
  .meta({ id: 'DescribedField' });

export const DescribedObjectDto = z
  .object({
    name: z.string(),
    label: z.string(),
    labelPlural: z.string(),
    custom: z.boolean(),
    icon: z.string(),
    color: z.string(),
    nameFields: z.array(z.string()),
    access: ObjectAccessFlags,
    recordTypes: z.array(
      z.object({ id: Uuid, name: z.string(), apiName: z.string(), default: z.boolean() }),
    ),
    fields: z.array(DescribedFieldDto),
  })
  .meta({ id: 'DescribedObject' });

// ── Records ─────────────────────────────────────────────────────────────────────────────────
/**
 * A record as the caller may see it: `id`, `version`, and the readable fields requested (lookups
 * as `{ id, name, object }`, the name only when the caller may see the target; money as Money).
 */
export const RecordDto = z
  .object({ id: Uuid, version: z.number().int() })
  .catchall(z.unknown())
  .meta({ id: 'Record' });

export const RecordPage = z
  .object({ items: z.array(RecordDto), nextCursor: z.string().nullable() })
  .meta({ id: 'RecordPage' });

/** Field API name → value. Money fields take Money (or a decimal string in the record's currency). */
export const WriteFieldsRequest = z
  .object({
    fields: z.record(FieldName, z.unknown()),
    /** The currency of the record's money fields; Money values may carry it instead. */
    currencyCode: CurrencyCode.optional(),
  })
  .strict()
  .meta({ id: 'WriteRecord' });

export const ObjectParam = z.object({ object: ObjectApiName });
export const RecordParam = z.object({ object: ObjectApiName, id: Uuid });
export const ExternalIdParam = z.object({
  object: ObjectApiName,
  externalId: z.string().min(1).max(255),
});

/** `?fields=a,b.c&sort=-amount,name&limit=50&cursor=…&filter[stage][in]=a,b` (§10.1). */
export const ListRecordsQuery = z
  .object({
    fields: z.string().max(4000).optional(),
    sort: z.string().max(400).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().max(4000).optional(),
  })
  .catchall(z.unknown());
export const GetRecordQuery = z.object({ fields: z.string().max(4000).optional() }).strict();

export const OptionalIdempotencyHeaders = z.object({
  'idempotency-key': z
    .string()
    .min(8)
    .max(128)
    .optional()
    .describe('Retries with the same key within 24 h replay the first response'),
});
export const IfMatchHeaders = z.object({
  'if-match': z
    .string()
    .regex(/^(W\/)?"?\d+"?$/, 'Must be the record version')
    .optional()
    .describe('The version the change is based on; 409 if the record changed since'),
});

/** SMQ (§3.8). */
export const QueryRequest = z
  .object({
    object: ObjectApiName,
    fields: z.array(FieldPath).min(1).max(100),
    where: z.unknown().optional(),
    orderBy: z
      .array(z.object({ field: FieldPath, direction: z.enum(['asc', 'desc']).default('asc') }))
      .max(3)
      .optional(),
    limit: z.number().int().min(1).max(2000).optional(),
    cursor: z.string().max(4000).optional(),
    scope: z.enum(['all', 'recent']).optional(),
  })
  .strict()
  .meta({ id: 'SmqQuery' });

// ── Mass actions, teams, recycle bin ────────────────────────────────────────────────────────
export const MassActionRequest = z
  .object({
    ids: z.array(Uuid).min(1).max(10_000).optional(),
    where: z.unknown().optional(),
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('update'), fields: z.record(FieldName, z.unknown()) }).strict(),
      z
        .object({
          kind: z.literal('transfer'),
          ownerId: Uuid,
          opportunities: z.enum(['none', 'open', 'all']).optional(),
          keepTeams: z.boolean().optional(),
        })
        .strict(),
      z.object({ kind: z.literal('delete') }).strict(),
    ]),
  })
  .strict()
  .meta({ id: 'MassAction' });

export const JobDto = z
  .object({
    id: Uuid,
    kind: z.string(),
    status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']),
    done: z.number().int(),
    total: z.number().int().nullable(),
    failed: z.number().int(),
    result: z.unknown().nullable(),
    error: z.string().nullable(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .meta({ id: 'Job' });

export const TeamObjectParam = z.object({
  object: z.enum(['account', 'opportunity']),
  id: Uuid,
});
export const TeamMemberParam = TeamObjectParam.extend({ userId: Uuid });
export const TeamMemberDto = z
  .object({
    id: Uuid,
    userId: Uuid,
    role: z.string().nullable(),
    access: z.number().int(),
    opportunityAccess: z.number().int().nullable(),
  })
  .meta({ id: 'TeamMember' });
export const PutTeamMemberRequest = z
  .object({
    role: z.string().trim().max(80).nullable().optional(),
    access: z.union([z.literal(1), z.literal(2)]),
    opportunityAccess: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  })
  .strict();

export const RecycleBinItemDto = z
  .object({
    id: Uuid,
    object: z.string(),
    recordId: Uuid,
    name: z.string(),
    deletedAt: z.string(),
    deletedBy: Uuid.nullable(),
    purgeAfter: z.string(),
  })
  .meta({ id: 'RecycleBinItem' });

const errorsOf = {
  400: { description: 'Invalid request or field values' },
  403: { description: 'Not allowed for this record or field' },
  404: { description: 'No such object or record visible to the caller' },
};
/** Internal until API keys arrive (P03); then these become the published public API. */
const route = (spec: Omit<Parameters<typeof defineRoute>[0], 'tags' | 'auth' | 'visibility'>) =>
  defineRoute({ ...spec, tags: ['records'], auth: 'session', visibility: 'internal' });

export const recordRoutes = {
  listObjects: route({
    method: 'get',
    path: '/v1/objects',
    operationId: 'listObjects',
    summary: 'Objects the caller can read',
    responses: {
      200: { description: 'Objects', body: z.object({ items: z.array(ObjectSummaryDto) }) },
    },
  }),
  describeObject: route({
    method: 'get',
    path: '/v1/objects/{object}/describe',
    operationId: 'describeObject',
    summary: 'An object’s fields visible to the caller, with what they may edit',
    request: { params: ObjectParam },
    responses: { 200: { description: 'The object', body: DescribedObjectDto }, ...errorsOf },
  }),
  listRecords: route({
    method: 'get',
    path: '/v1/records/{object}',
    operationId: 'listRecords',
    summary: 'Records the caller can see, filtered, sorted and paged by cursor',
    request: { params: ObjectParam, query: ListRecordsQuery },
    responses: { 200: { description: 'A page of records', body: RecordPage }, ...errorsOf },
  }),
  createRecord: route({
    method: 'post',
    path: '/v1/records/{object}',
    operationId: 'createRecord',
    summary: 'Create a record',
    request: { params: ObjectParam, headers: OptionalIdempotencyHeaders, body: WriteFieldsRequest },
    responses: {
      201: { description: 'The record', body: RecordDto },
      409: { description: 'A unique value is taken, or the idempotency key is in use' },
      422: { description: 'Required fields, references or validation rules failed' },
      ...errorsOf,
    },
  }),
  getRecord: route({
    method: 'get',
    path: '/v1/records/{object}/{id}',
    operationId: 'getRecord',
    summary: 'A record',
    request: { params: RecordParam, query: GetRecordQuery },
    responses: { 200: { description: 'The record', body: RecordDto }, ...errorsOf },
  }),
  updateRecord: route({
    method: 'patch',
    path: '/v1/records/{object}/{id}',
    operationId: 'updateRecord',
    summary: 'Change a record’s fields',
    request: { params: RecordParam, headers: IfMatchHeaders, body: WriteFieldsRequest },
    responses: {
      200: { description: 'The record', body: RecordDto },
      409: { description: 'The record changed since the If-Match version, or is locked' },
      422: { description: 'Required fields, references or validation rules failed' },
      ...errorsOf,
    },
  }),
  deleteRecord: route({
    method: 'delete',
    path: '/v1/records/{object}/{id}',
    operationId: 'deleteRecord',
    summary: 'Move a record (and what cascades with it) to the recycle bin',
    request: { params: RecordParam },
    responses: { 204: { description: 'Deleted' }, ...errorsOf },
  }),
  upsertRecord: route({
    method: 'put',
    path: '/v1/records/{object}/external/{externalId}',
    operationId: 'upsertRecord',
    summary: 'Create or update the record with this external id',
    request: { params: ExternalIdParam, body: WriteFieldsRequest },
    responses: {
      200: { description: 'Updated', body: RecordDto },
      201: { description: 'Created', body: RecordDto },
      422: { description: 'Required fields, references or validation rules failed' },
      ...errorsOf,
    },
  }),
  query: route({
    method: 'post',
    path: '/v1/query',
    operationId: 'query',
    summary: 'Run an SMQ query (§3.8)',
    request: { body: QueryRequest },
    responses: { 200: { description: 'A page of records', body: RecordPage }, ...errorsOf },
  }),
  previewMassAction: route({
    method: 'post',
    path: '/v1/records/{object}/mass/preview',
    operationId: 'previewMassAction',
    summary: 'How many records a mass action would touch',
    request: { params: ObjectParam, body: MassActionRequest },
    responses: {
      200: {
        description: 'The count',
        body: z.object({ count: z.number().int(), tooMany: z.boolean() }),
      },
      ...errorsOf,
    },
  }),
  startMassAction: route({
    method: 'post',
    path: '/v1/records/{object}/mass',
    operationId: 'startMassAction',
    summary: 'Run a mass update, transfer or delete as a job (up to 10,000 records)',
    request: { params: ObjectParam, body: MassActionRequest },
    responses: { 202: { description: 'The job', body: JobDto }, ...errorsOf },
  }),
  getJob: route({
    method: 'get',
    path: '/v1/jobs/{id}',
    operationId: 'getJob',
    summary: 'Progress of a job the caller started',
    request: { params: z.object({ id: Uuid }) },
    responses: { 200: { description: 'The job', body: JobDto }, 404: errorsOf[404] },
  }),
  listTeam: route({
    method: 'get',
    path: '/v1/records/{object}/{id}/team',
    operationId: 'listRecordTeam',
    summary: 'An account’s or opportunity’s team',
    request: { params: TeamObjectParam },
    responses: {
      200: { description: 'Members', body: z.object({ items: z.array(TeamMemberDto) }) },
      ...errorsOf,
    },
  }),
  putTeamMember: route({
    method: 'put',
    path: '/v1/records/{object}/{id}/team/{userId}',
    operationId: 'putRecordTeamMember',
    summary: 'Add a team member or change their access (needs Full access to the record)',
    request: { params: TeamMemberParam, body: PutTeamMemberRequest },
    responses: {
      200: { description: 'Members', body: z.object({ items: z.array(TeamMemberDto) }) },
      ...errorsOf,
    },
  }),
  deleteTeamMember: route({
    method: 'delete',
    path: '/v1/records/{object}/{id}/team/{userId}',
    operationId: 'deleteRecordTeamMember',
    summary: 'Remove a team member (needs Full access to the record)',
    request: { params: TeamMemberParam },
    responses: { 204: { description: 'Removed' }, ...errorsOf },
  }),
  listRecycleBin: route({
    method: 'get',
    path: '/v1/recycle-bin',
    operationId: 'listRecycleBin',
    summary: 'What the caller deleted (everything, for users who may modify all data)',
    responses: {
      200: {
        description: 'Recycle bin items',
        body: z.object({ items: z.array(RecycleBinItemDto) }),
      },
    },
  }),
  restoreRecord: route({
    method: 'post',
    path: '/v1/records/{object}/{id}/restore',
    operationId: 'restoreRecord',
    summary: 'Restore a record from the recycle bin, with what was deleted with it',
    request: { params: RecordParam },
    responses: {
      200: { description: 'Restored', body: z.object({ restored: z.number().int() }) },
      409: { description: 'Restore the parent record instead' },
      ...errorsOf,
    },
  }),
};

// ── Lead conversion (§7.3) ───────────────────────────────────────────────────────────────────
const ExistingOrNew = z.union([
  z.object({ id: Uuid }).strict(),
  z.object({ fields: z.record(FieldName, z.unknown()).optional() }).strict(),
]);
export const ConvertLeadRequest = z
  .object({
    account: ExistingOrNew,
    contact: ExistingOrNew,
    opportunity: z
      .object({ fields: z.record(FieldName, z.unknown()).optional() })
      .strict()
      .nullable()
      .optional(),
    ownerId: Uuid.optional(),
    convertedStatus: z.string().max(80).optional(),
  })
  .strict()
  .meta({ id: 'ConvertLead' });
export const ConvertLeadResult = z
  .object({
    conversionId: Uuid,
    accountId: Uuid,
    contactId: Uuid,
    opportunityId: Uuid.nullable(),
  })
  .meta({ id: 'LeadConversion' });
export const LeadParam = z.object({ id: Uuid });

export const FieldMappingDto = z
  .object({
    leadField: FieldName,
    targetObject: z.enum(['account', 'contact', 'opportunity']),
    targetField: FieldName,
  })
  .strict()
  .meta({ id: 'LeadFieldMapping' });
export const PutFieldMappingRequest = z
  .object({ mappings: z.array(FieldMappingDto).max(500) })
  .strict();

export const leadRoutes = {
  convertLead: route({
    method: 'post',
    path: '/v1/leads/{id}/convert',
    operationId: 'convertLead',
    summary: 'Convert a lead into an account, a contact and optionally an opportunity',
    request: { params: LeadParam, body: ConvertLeadRequest },
    responses: {
      200: { description: 'What the lead became', body: ConvertLeadResult },
      409: { description: 'Already converted' },
      422: { description: 'A created record failed its checks' },
      ...errorsOf,
    },
  }),
  undoLeadConversion: route({
    method: 'post',
    path: '/v1/leads/{id}/convert/undo',
    operationId: 'undoLeadConversion',
    summary: 'Undo a conversion within 24 hours, if nothing it wrote has changed since',
    request: { params: LeadParam },
    responses: {
      204: { description: 'Undone' },
      409: { description: 'Too late, or something changed since' },
      ...errorsOf,
    },
  }),
  getLeadFieldMapping: route({
    method: 'get',
    path: '/v1/leads/field-mapping',
    operationId: 'getLeadFieldMapping',
    summary: 'How lead fields map to the records conversion creates (defaults and admin mappings)',
    responses: {
      200: {
        description: 'Effective mappings and the admin’s own',
        body: z.object({ effective: z.array(FieldMappingDto), custom: z.array(FieldMappingDto) }),
      },
      403: errorsOf[403],
    },
  }),
  putLeadFieldMapping: route({
    method: 'put',
    path: '/v1/leads/field-mapping',
    operationId: 'putLeadFieldMapping',
    summary: 'Replace the admin’s lead conversion mappings (types are checked)',
    request: { body: PutFieldMappingRequest },
    responses: {
      200: {
        description: 'Effective mappings and the admin’s own',
        body: z.object({ effective: z.array(FieldMappingDto), custom: z.array(FieldMappingDto) }),
      },
      400: errorsOf[400],
      403: errorsOf[403],
    },
  }),
};
