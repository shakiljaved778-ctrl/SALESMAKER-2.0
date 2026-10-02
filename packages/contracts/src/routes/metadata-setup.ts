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
