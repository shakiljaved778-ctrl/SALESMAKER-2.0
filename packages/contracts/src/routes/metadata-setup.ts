import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { Uuid } from '../primitives.js';
import { ObjectApiName } from './access.js';

/*
 * Setup → Object manager (§5): custom fields, picklist values and field settings. Reading needs
 * view_setup; every change needs customize_application. Every change bumps the tenant's
 * metadata version, so caches pick it up (§3.10), and is recorded in the setup audit.
 */

/** Field types an admin can create in P02. Formula, roll-up and auto-number fields come later. */
export const CUSTOM_FIELD_TYPES = [
  'text',
  'textarea',
  'long_text',
  'email',
  'phone',
  'url',
  'number',
  'currency',
  'percent',
  'date',
  'datetime',
  'checkbox',
  'picklist',
  'multi_picklist',
  'lookup',
] as const;
export const CustomFieldType = z.enum(CUSTOM_FIELD_TYPES);

/** The name an admin gives; stored as `<name>__c`. */
const CustomName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,34}$/, 'Lower-case letters, digits and underscores, from a letter')
  .refine((n) => !n.includes('__'), 'No double underscores');
const FieldName = z.string().regex(/^[a-z][a-z0-9_]{0,38}$/);
const Label = z.string().trim().min(1).max(80);
const Text = z.string().trim().max(1000);

export const PicklistValueInput = z
  .object({
    apiValue: z.string().regex(/^[a-z0-9][a-z0-9_]{0,79}$/, 'Lower-case value without spaces'),
    label: Label.nullable().optional(),
    active: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    /** Lead status only: the system category (§4.3). */
    category: z.string().max(40).nullable().optional(),
  })
  .strict();

export const PicklistValueDto = z
  .object({
    id: Uuid,
    apiValue: z.string(),
    label: z.string().nullable(),
    labelKey: z.string().nullable(),
    active: z.boolean(),
    isDefault: z.boolean(),
    category: z.string().nullable(),
    sortOrder: z.number().int(),
  })
  .meta({ id: 'PicklistValueSetting' });

export const FieldSettingDto = z
  .object({
    id: Uuid,
    apiName: z.string(),
    custom: z.boolean(),
    type: z.string(),
    label: z.string().nullable(),
    labelKey: z.string().nullable(),
    description: z.string().nullable(),
    helpText: z.string().nullable(),
    required: z.boolean(),
    unique: z.boolean(),
    system: z.boolean(),
    externalId: z.boolean(),
    searchable: z.boolean(),
    trackHistory: z.boolean(),
    indexed: z.boolean(),
    /** PENDING / READY / FAILED once indexing is requested (ADR-0030). */
    indexStatus: z.string().nullable(),
    length: z.number().int().nullable(),
    precision: z.number().int().nullable(),
    scale: z.number().int().nullable(),
    referenceTo: z.array(z.string()),
    defaultValue: z.unknown().nullable(),
    picklistValues: z.array(PicklistValueDto),
    version: z.number().int(),
  })
  .meta({ id: 'FieldSetting' });

export const CreateFieldRequest = z
  .object({
    name: CustomName,
    label: Label,
    type: CustomFieldType,
    description: Text.nullable().optional(),
    helpText: Text.nullable().optional(),
    required: z.boolean().optional(),
    trackHistory: z.boolean().optional(),
    /** Request a per-tenant index for filtering and sorting (Q11, ADR-0030; up to 10 per object). */
    indexed: z.boolean().optional(),
    /** Text types: maximum length. */
    length: z.number().int().min(1).max(131_072).optional(),
    /** Number, currency, percent: digits in total and after the point. */
    precision: z.number().int().min(1).max(18).optional(),
    scale: z.number().int().min(0).max(8).optional(),
    /** Lookup: the target object. */
    referenceTo: ObjectApiName.optional(),
    defaultValue: z.unknown().optional(),
    picklistValues: z.array(PicklistValueInput).max(500).optional(),
    /** Field-level security: which permission sets (a profile's or any other) read and edit it. */
    access: z
      .array(z.object({ permissionSetId: Uuid, read: z.boolean(), edit: z.boolean() }).strict())
      .max(200)
      .optional(),
  })
  .strict()
  .meta({ id: 'CreateField' });

/** Settings that can change after creation; the API name never does (§3.1). */
export const UpdateFieldRequest = z
  .object({
    version: z.number().int().positive(),
    label: Label.nullable().optional(),
    description: Text.nullable().optional(),
    helpText: Text.nullable().optional(),
    required: z.boolean().optional(),
    trackHistory: z.boolean().optional(),
    indexed: z.boolean().optional(),
    /** Only safe widenings: text → long text, longer text, more digits. */
    type: CustomFieldType.optional(),
    length: z.number().int().min(1).max(131_072).optional(),
    precision: z.number().int().min(1).max(18).optional(),
    scale: z.number().int().min(0).max(8).optional(),
    defaultValue: z.unknown().optional(),
  })
  .strict()
  .meta({ id: 'UpdateField' });

export const PutPicklistValuesRequest = z
  .object({
    version: z.number().int().positive(),
    /** The full, ordered list. Values are never removed (records keep them): leave one out and it is deactivated. */
    values: z.array(PicklistValueInput).min(1).max(500),
  })
  .strict();

export const FieldParam = z.object({ object: ObjectApiName, field: FieldName });
export const SetupObjectParam = z.object({ object: ObjectApiName });

const forbidden = { 403: { description: 'The caller lacks the required system permission' } };
const notFound = { 404: { description: 'No such object or field' } };
const route = (spec: Omit<Parameters<typeof defineRoute>[0], 'tags' | 'auth' | 'visibility'>) =>
  defineRoute({ ...spec, tags: ['setup'], auth: 'session', visibility: 'internal' });

export const metadataSetupRoutes = {
  listFields: route({
    method: 'get',
    path: '/v1/setup/objects/{object}/fields',
    operationId: 'listFieldSettings',
    summary: 'Every field of an object with its settings (Setup → Object manager)',
    request: { params: SetupObjectParam },
    responses: {
      200: { description: 'Fields', body: z.object({ items: z.array(FieldSettingDto) }) },
      ...forbidden,
      ...notFound,
    },
  }),
  createField: route({
    method: 'post',
    path: '/v1/setup/objects/{object}/fields',
    operationId: 'createCustomField',
    summary: 'Create a custom field (stored as <name>__c)',
    request: { params: SetupObjectParam, body: CreateFieldRequest },
    responses: {
      201: { description: 'The field', body: FieldSettingDto },
      400: { description: 'Invalid settings for the type' },
      409: { description: 'The name is taken, or a limit is reached' },
      ...forbidden,
      ...notFound,
    },
  }),
  updateField: route({
    method: 'patch',
    path: '/v1/setup/objects/{object}/fields/{field}',
    operationId: 'updateFieldSettings',
    summary:
      'Change a field’s settings (standard fields: label, description, help and history only)',
    request: { params: FieldParam, body: UpdateFieldRequest },
    responses: {
      200: { description: 'The field', body: FieldSettingDto },
      400: { description: 'Not allowed for this field or type' },
      409: { description: 'Stale version, or a limit is reached' },
      ...forbidden,
      ...notFound,
    },
  }),
  deleteField: route({
    method: 'delete',
    path: '/v1/setup/objects/{object}/fields/{field}',
    operationId: 'deleteCustomField',
    summary: 'Delete a custom field (it disappears from layouts, rules and access)',
    request: { params: FieldParam },
    responses: {
      204: { description: 'Deleted' },
      400: { description: 'A standard field' },
      409: { description: 'Still used by a validation rule or path' },
      ...forbidden,
      ...notFound,
    },
  }),
  putPicklistValues: route({
    method: 'put',
    path: '/v1/setup/objects/{object}/fields/{field}/picklist-values',
    operationId: 'putPicklistValues',
    summary: 'Set a picklist’s values, order, labels and default',
    request: { params: FieldParam, body: PutPicklistValuesRequest },
    responses: {
      200: { description: 'The field', body: FieldSettingDto },
      400: { description: 'Invalid values' },
      409: { description: 'Stale version' },
      ...forbidden,
      ...notFound,
    },
  }),
};

// ── Record types, layouts, compact layouts, paths, validation rules (T15b) ──────────────────
const ApiName = z.string().regex(/^[a-z][a-z0-9_]{0,38}$/, 'Lower-case API name');
const Version = z.number().int().positive();
export const SetupItemParam = z.object({ object: ObjectApiName, id: Uuid });

export const RecordTypeDto = z
  .object({
    id: Uuid,
    apiName: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    active: z.boolean(),
    isDefault: z.boolean(),
    pipelineId: Uuid.nullable(),
    /** Picklist field → the values this record type offers (absent: all of them). */
    picklistValues: z.record(z.string(), z.array(z.string())),
    version: z.number().int(),
  })
  .meta({ id: 'RecordTypeSetting' });
const RecordTypeFields = {
  name: Label,
  description: Text.nullable().optional(),
  isDefault: z.boolean().optional(),
  pipelineId: Uuid.nullable().optional(),
  picklistValues: z.record(FieldName, z.array(z.string()).min(1)).optional(),
};
export const CreateRecordTypeRequest = z
  .object({ apiName: ApiName, ...RecordTypeFields })
  .strict()
  .meta({ id: 'CreateRecordType' });
export const UpdateRecordTypeRequest = z
  .object({
    version: Version,
    ...RecordTypeFields,
    name: Label.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .meta({ id: 'UpdateRecordType' });

export const LayoutSectionInput = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
    label: Label.nullable().optional(),
    labelKey: z.string().max(120).nullable().optional(),
    columns: z.union([z.literal(1), z.literal(2)]),
    fields: z
      .array(
        z
          .object({
            field: FieldName,
            required: z.boolean().optional(),
            readOnly: z.boolean().optional(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export const RelatedListInput = z
  .object({
    object: ObjectApiName,
    field: FieldName,
    columns: z.array(FieldName).min(1).max(10),
    sort: z
      .object({ field: FieldName, direction: z.enum(['asc', 'desc']) })
      .strict()
      .optional(),
  })
  .strict();
export const PageLayoutDto = z
  .object({
    id: Uuid,
    name: z.string(),
    isDefault: z.boolean(),
    sections: z.array(LayoutSectionInput),
    relatedLists: z.array(RelatedListInput),
    version: z.number().int(),
  })
  .meta({ id: 'PageLayoutSetting' });
const LayoutFields = {
  name: Label,
  isDefault: z.boolean().optional(),
  sections: z.array(LayoutSectionInput).min(1).max(30),
  relatedLists: z.array(RelatedListInput).max(20).optional(),
};
export const CreateLayoutRequest = z.object(LayoutFields).strict().meta({ id: 'CreatePageLayout' });
export const UpdateLayoutRequest = z
  .object({
    version: Version,
    name: Label.optional(),
    isDefault: z.boolean().optional(),
    sections: LayoutFields.sections.optional(),
    relatedLists: LayoutFields.relatedLists,
  })
  .strict()
  .meta({ id: 'UpdatePageLayout' });

export const LayoutAssignmentDto = z
  .object({ profileId: Uuid, recordTypeId: Uuid, pageLayoutId: Uuid })
  .strict()
  .meta({ id: 'LayoutAssignment' });
export const PutLayoutAssignmentsRequest = z
  .object({ assignments: z.array(LayoutAssignmentDto).max(2000) })
  .strict();

export const CompactLayoutDto = z
  .object({
    id: Uuid,
    name: z.string(),
    isDefault: z.boolean(),
    fields: z.array(z.string()),
    version: z.number().int(),
  })
  .meta({ id: 'CompactLayoutSetting' });
export const CreateCompactLayoutRequest = z
  .object({
    name: Label,
    isDefault: z.boolean().optional(),
    fields: z.array(FieldName).min(1).max(7),
  })
  .strict();
export const UpdateCompactLayoutRequest = z
  .object({
    version: Version,
    name: Label.optional(),
    isDefault: z.boolean().optional(),
    fields: z.array(FieldName).min(1).max(7).optional(),
  })
  .strict();

export const PathStepInput = z
  .object({ keyFields: z.array(FieldName).max(5), guidance: z.string().max(2000) })
  .strict();
export const PathDto = z
  .object({
    id: Uuid,
    recordTypeId: Uuid,
    field: z.string(),
    active: z.boolean(),
    steps: z.record(z.string(), PathStepInput),
    version: z.number().int(),
  })
  .meta({ id: 'PathSetting' });
export const PutPathRequest = z
  .object({ active: z.boolean(), steps: z.record(z.string(), PathStepInput) })
  .strict();
export const PathParam = z.object({ object: ObjectApiName, recordTypeId: Uuid, field: FieldName });

export const ValidationRuleDto = z
  .object({
    id: Uuid,
    apiName: z.string(),
    description: z.string().nullable(),
    formula: z.string(),
    errorMessage: z.string(),
    errorField: z.string().nullable(),
    active: z.boolean(),
    version: z.number().int(),
  })
  .meta({ id: 'ValidationRuleSetting' });
const RuleFields = {
  description: Text.nullable().optional(),
  formula: z.string().min(1).max(5000),
  errorMessage: z.string().trim().min(1).max(255),
  errorField: FieldName.nullable().optional(),
  active: z.boolean().optional(),
};
export const CreateValidationRuleRequest = z
  .object({ apiName: ApiName, ...RuleFields })
  .strict()
  .meta({ id: 'CreateValidationRule' });
export const UpdateValidationRuleRequest = z
  .object({
    version: Version,
    ...RuleFields,
    formula: RuleFields.formula.optional(),
    errorMessage: RuleFields.errorMessage.optional(),
  })
  .strict()
  .meta({ id: 'UpdateValidationRule' });

const crudOf = (
  segment: string,
  noun: string,
  ids: { list: string; create: string; update: string; remove?: string },
  shapes: { item: z.ZodType; create: z.ZodType; update: z.ZodType },
) => ({
  [ids.list]: route({
    method: 'get',
    path: `/v1/setup/objects/{object}/${segment}`,
    operationId: ids.list,
    summary: `An object’s ${noun}s`,
    request: { params: SetupObjectParam },
    responses: {
      200: { description: `${noun}s`, body: z.object({ items: z.array(shapes.item) }) },
      ...forbidden,
      ...notFound,
    },
  }),
  [ids.create]: route({
    method: 'post',
    path: `/v1/setup/objects/{object}/${segment}`,
    operationId: ids.create,
    summary: `Create a ${noun}`,
    request: { params: SetupObjectParam, body: shapes.create },
    responses: {
      201: { description: `The ${noun}`, body: shapes.item },
      400: { description: 'Invalid settings' },
      409: { description: 'The name is taken' },
      ...forbidden,
      ...notFound,
    },
  }),
  [ids.update]: route({
    method: 'patch',
    path: `/v1/setup/objects/{object}/${segment}/{id}`,
    operationId: ids.update,
    summary: `Change a ${noun}`,
    request: { params: SetupItemParam, body: shapes.update },
    responses: {
      200: { description: `The ${noun}`, body: shapes.item },
      400: { description: 'Invalid settings' },
      409: { description: 'Stale version' },
      ...forbidden,
      ...notFound,
    },
  }),
  ...(ids.remove
    ? {
        [ids.remove]: route({
          method: 'delete',
          path: `/v1/setup/objects/{object}/${segment}/{id}`,
          operationId: ids.remove,
          summary: `Delete a ${noun}`,
          request: { params: SetupItemParam },
          responses: {
            204: { description: 'Deleted' },
            409: { description: 'The default cannot be deleted' },
            ...forbidden,
            ...notFound,
          },
        }),
      }
    : {}),
});

export const layoutSetupRoutes = {
  ...crudOf(
    'record-types',
    'record type',
    { list: 'listRecordTypes', create: 'createRecordType', update: 'updateRecordType' },
    { item: RecordTypeDto, create: CreateRecordTypeRequest, update: UpdateRecordTypeRequest },
  ),
  ...crudOf(
    'layouts',
    'page layout',
    {
      list: 'listPageLayouts',
      create: 'createPageLayout',
      update: 'updatePageLayout',
      remove: 'deletePageLayout',
    },
    { item: PageLayoutDto, create: CreateLayoutRequest, update: UpdateLayoutRequest },
  ),
  ...crudOf(
    'compact-layouts',
    'compact layout',
    {
      list: 'listCompactLayouts',
      create: 'createCompactLayout',
      update: 'updateCompactLayout',
      remove: 'deleteCompactLayout',
    },
    {
      item: CompactLayoutDto,
      create: CreateCompactLayoutRequest,
      update: UpdateCompactLayoutRequest,
    },
  ),
  ...crudOf(
    'validation-rules',
    'validation rule',
    {
      list: 'listValidationRules',
      create: 'createValidationRule',
      update: 'updateValidationRule',
      remove: 'deleteValidationRule',
    },
    {
      item: ValidationRuleDto,
      create: CreateValidationRuleRequest,
      update: UpdateValidationRuleRequest,
    },
  ),
  getLayoutAssignments: route({
    method: 'get',
    path: '/v1/setup/objects/{object}/layout-assignments',
    operationId: 'getLayoutAssignments',
    summary: 'Which layout each profile sees per record type (default layout elsewhere)',
    request: { params: SetupObjectParam },
    responses: {
      200: { description: 'Assignments', body: z.object({ items: z.array(LayoutAssignmentDto) }) },
      ...forbidden,
      ...notFound,
    },
  }),
  putLayoutAssignments: route({
    method: 'put',
    path: '/v1/setup/objects/{object}/layout-assignments',
    operationId: 'putLayoutAssignments',
    summary: 'Replace the object’s layout assignments',
    request: { params: SetupObjectParam, body: PutLayoutAssignmentsRequest },
    responses: {
      200: { description: 'Assignments', body: z.object({ items: z.array(LayoutAssignmentDto) }) },
      400: { description: 'Unknown profile, record type or layout' },
      ...forbidden,
      ...notFound,
    },
  }),
  listPaths: route({
    method: 'get',
    path: '/v1/setup/objects/{object}/paths',
    operationId: 'listPaths',
    summary: 'Path guidance per record type and picklist',
    request: { params: SetupObjectParam },
    responses: {
      200: { description: 'Paths', body: z.object({ items: z.array(PathDto) }) },
      ...forbidden,
      ...notFound,
    },
  }),
  putPath: route({
    method: 'put',
    path: '/v1/setup/objects/{object}/paths/{recordTypeId}/{field}',
    operationId: 'putPath',
    summary: 'Set the path (key fields and guidance per step) for a record type’s picklist',
    request: { params: PathParam, body: PutPathRequest },
    responses: {
      200: { description: 'The path', body: PathDto },
      400: { description: 'Not a picklist, or unknown steps or fields' },
      ...forbidden,
      ...notFound,
    },
  }),
  deletePath: route({
    method: 'delete',
    path: '/v1/setup/objects/{object}/paths/{recordTypeId}/{field}',
    operationId: 'deletePath',
    summary: 'Remove a path',
    request: { params: PathParam },
    responses: { 204: { description: 'Removed' }, ...forbidden, ...notFound },
  }),
};
