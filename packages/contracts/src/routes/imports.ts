import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { Uuid } from '../primitives.js';

/*
 * Data import (§7.1): the browser uploads the file to object storage through a pre-signed URL,
 * the API reads its sheets and headers and suggests a mapping, the user maps, optionally dry
 * runs, then starts the job; the worker runs it and the results file is downloaded the same way.
 */

/** Largest file accepted per type: CSV is streamed, XLSX is read whole (a zip). */
export const IMPORT_MAX_BYTES = { csv: 500 * 1024 * 1024, xlsx: 100 * 1024 * 1024 } as const;

export const ImportStatus = z.enum([
  'UPLOADED',
  'READY',
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'UNDOING',
  'UNDONE',
]);
export const ImportDuplicateMode = z.enum(['SKIP', 'UPDATE', 'CREATE']);
const FileType = z.enum(['csv', 'xlsx']);

export const ImportColumnMapping = z
  .object({
    /** Index of the column in the file (0-based). */
    column: z.number().int().min(0).max(999),
    /** The field it fills, or `currency_code` for the row's currency. */
    field: z.string().min(1).max(80),
    /** Picklists: file value (any case) → API value. */
    values: z.record(z.string().max(255), z.string().max(255)).optional(),
    /** Dates: the order of day, month and year (ISO dates always work). */
    dateOrder: z.enum(['DMY', 'MDY', 'YMD']).optional(),
    /** Phones without a country code get this one, e.g. `+974`. */
    phoneCountry: z
      .string()
      .regex(/^\+\d{1,4}$/)
      .optional(),
    /** owner_id: find the user by email or name (else the column holds user ids). */
    ownerBy: z.enum(['email', 'name', 'id']).optional(),
  })
  .strict()
  .meta({ id: 'ImportColumnMapping' });

const DefaultValue = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);

export const ImportDryRunDto = z
  .object({
    rows: z.number().int(),
    created: z.number().int(),
    updated: z.number().int(),
    skipped: z.number().int(),
    failed: z.number().int(),
    /** Rows that would fail or be skipped, with `field:code` errors (never values). */
    problems: z.array(
      z.object({ row: z.number().int(), status: z.string(), errors: z.array(z.string()) }),
    ),
  })
  .meta({ id: 'ImportDryRun' });

export const ImportJobDto = z
  .object({
    id: Uuid,
    object: z.string(),
    status: ImportStatus,
    fileName: z.string(),
    fileSize: z.number().int(),
    fileType: FileType,
    sheet: z.string().nullable(),
    headerRow: z.number().int(),
    headers: z.array(z.string()),
    mapping: z.array(ImportColumnMapping),
    duplicateMode: ImportDuplicateMode,
    matchingRuleId: Uuid.nullable(),
    runAssignment: z.boolean(),
    assignmentRuleId: Uuid.nullable(),
    defaults: z.record(z.string(), DefaultValue),
    dryRun: ImportDryRunDto.nullable(),
    total: z.number().int().nullable(),
    processed: z.number().int(),
    created: z.number().int(),
    updated: z.number().int(),
    skipped: z.number().int(),
    failed: z.number().int(),
    error: z.string().nullable(),
    hasResults: z.boolean(),
    /** Until when the import may be undone; null when it cannot be. */
    undoableUntil: z.iso.datetime().nullable(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    undoneAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    createdBy: z.object({ id: Uuid, name: z.string() }).nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'ImportJob' });

export const CreateImportRequest = z
  .object({
    object: z.string().min(1).max(80),
    fileName: z.string().trim().min(1).max(255),
    fileType: FileType,
    /** Exact size in bytes: the upload URL only accepts a body of this length. */
    fileSize: z.number().int().positive(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.fileSize > IMPORT_MAX_BYTES[v.fileType])
      ctx.addIssue({ code: 'custom', path: ['fileSize'], message: 'File too large' });
  });

export const CreateImportResponse = z
  .object({
    job: ImportJobDto,
    upload: z.object({
      url: z.url(),
      method: z.literal('PUT'),
      headers: z.record(z.string(), z.string()),
      expiresAt: z.iso.datetime(),
    }),
  })
  .meta({ id: 'CreateImportResponse' });

export const AnalyseImportRequest = z
  .object({
    /** XLSX: the sheet to read (the first when omitted). */
    sheet: z.string().max(255).nullable().optional(),
    /** The row holding the headers (1-based). */
    headerRow: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const ImportAnalysisDto = z
  .object({
    job: ImportJobDto,
    /** XLSX sheet names in workbook order (empty for CSV). */
    sheets: z.array(z.string()),
    headers: z.array(z.string()),
    /** Up to 5 data rows after the header row. */
    sample: z.array(z.array(z.string())),
    /** Mapping suggested from API names, labels and synonyms. */
    suggestions: z.array(ImportColumnMapping),
    /** Saved mapping templates for files with the same headers. */
    templates: z.array(z.object({ id: Uuid, name: z.string() })),
  })
  .meta({ id: 'ImportAnalysis' });

export const UpdateImportRequest = z
  .object({
    mapping: z.array(ImportColumnMapping).max(500).optional(),
    duplicateMode: ImportDuplicateMode.optional(),
    matchingRuleId: Uuid.nullable().optional(),
    runAssignment: z.boolean().optional(),
    assignmentRuleId: Uuid.nullable().optional(),
    /** Values for fields a row leaves empty (lead source, campaign, owner). */
    defaults: z.record(z.string().max(80), DefaultValue).optional(),
    version: z.number().int().positive(),
  })
  .strict();

export const ImportsQuery = z
  .object({
    object: z.string().max(80).optional(),
    status: ImportStatus.optional(),
    /** Only the caller's imports (Setup viewers otherwise see everyone's). */
    mine: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const ImportRowsQuery = z
  .object({
    status: z.enum(['CREATED', 'UPDATED', 'SKIPPED', 'FAILED']).optional(),
    /** Rows after this row number (keyset). */
    after: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

export const ImportRowDto = z
  .object({
    row: z.number().int(),
    status: z.enum(['CREATED', 'UPDATED', 'SKIPPED', 'FAILED']),
    recordId: Uuid.nullable(),
    errors: z.array(z.object({ field: z.string(), code: z.string() })),
  })
  .meta({ id: 'ImportRow' });

export const ImportTemplateDto = z
  .object({
    id: Uuid,
    object: z.string(),
    name: z.string(),
    headers: z.string(),
    mapping: z.array(ImportColumnMapping),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ImportTemplate' });

export const CreateImportTemplateRequest = z
  .object({
    object: z.string().min(1).max(80),
    name: z.string().trim().min(1).max(80),
    /** The file's header row; templates are offered for files with the same headers. */
    headers: z.array(z.string().max(255)).min(1).max(1000),
    mapping: z.array(ImportColumnMapping).min(1).max(500),
  })
  .strict();

const IdParam = z.object({ id: Uuid });
const forbidden = { 403: { description: 'The caller lacks import_records' } };
const conflict = { 409: { description: 'The import is not in a state that allows this' } };
const unavailable = { 503: { description: 'Object storage is not configured' } };
const base = {
  tags: ['imports'],
  auth: 'session' as const,
  visibility: 'internal' as const,
};

export const importRoutes = {
  listImports: defineRoute({
    ...base,
    method: 'get',
    path: '/v1/imports',
    operationId: 'listImports',
    summary: 'Import history, newest first (own imports; everyone’s with view_setup)',
    request: { query: ImportsQuery },
    responses: {
      200: { description: 'Imports', body: z.object({ items: z.array(ImportJobDto) }) },
      ...forbidden,
    },
  }),
  createImport: defineRoute({
    ...base,
    method: 'post',
    path: '/v1/imports',
    operationId: 'createImport',
    summary: 'Start an import: the job and a pre-signed URL to upload the file to',
    request: { body: CreateImportRequest },
    responses: {
      201: { description: 'The job and its upload URL', body: CreateImportResponse },
      ...forbidden,
      ...unavailable,
    },
  }),
  getImport: defineRoute({
    ...base,
    method: 'get',
    path: '/v1/imports/{id}',
    operationId: 'getImport',
    summary: 'An import and its progress',
    request: { params: IdParam },
    responses: { 200: { description: 'The import', body: ImportJobDto }, ...forbidden },
  }),
  analyseImport: defineRoute({
    ...base,
    method: 'post',
    path: '/v1/imports/{id}/analyse',
    operationId: 'analyseImport',
    summary: 'Read the uploaded file: sheets, headers, a sample and suggested mappings',
    request: { params: IdParam, body: AnalyseImportRequest },
    responses: {
      200: { description: 'What the file holds', body: ImportAnalysisDto },
      ...forbidden,
      ...conflict,
      ...unavailable,
    },
  }),
  updateImport: defineRoute({
    ...base,
    method: 'patch',
    path: '/v1/imports/{id}',
    operationId: 'updateImport',
    summary: 'Set the mapping, duplicate handling, assignment and defaults',
    request: { params: IdParam, body: UpdateImportRequest },
    responses: {
      200: { description: 'The import', body: ImportJobDto },
      ...forbidden,
      ...conflict,
    },
  }),
  dryRunImport: defineRoute({
    ...base,
    method: 'post',
    path: '/v1/imports/{id}/dry-run',
    operationId: 'dryRunImport',
    summary: 'Run the first 100 rows without saving; the job is READY with `dryRun` when done',
    request: { params: IdParam },
    responses: {
      202: { description: 'Queued', body: ImportJobDto },
      ...forbidden,
      ...conflict,
      ...unavailable,
    },
  }),
  startImport: defineRoute({
    ...base,
    method: 'post',
    path: '/v1/imports/{id}/start',
    operationId: 'startImport',
    summary: 'Queue the import',
    request: { params: IdParam },
    responses: {
      202: { description: 'Queued', body: ImportJobDto },
      ...forbidden,
      ...conflict,
      ...unavailable,
    },
  }),
  cancelImport: defineRoute({
    ...base,
    method: 'post',
    path: '/v1/imports/{id}/cancel',
    operationId: 'cancelImport',
    summary: 'Cancel an import that has not started; its file is deleted',
    request: { params: IdParam },
    responses: {
      200: { description: 'Cancelled', body: ImportJobDto },
      ...forbidden,
      ...conflict,
    },
  }),
  undoImport: defineRoute({
    ...base,
    method: 'post',
    path: '/v1/imports/{id}/undo',
    operationId: 'undoImport',
    summary: 'Move the records an import created to the recycle bin (within 72 hours)',
    request: { params: IdParam },
    responses: {
      202: { description: 'Undoing', body: ImportJobDto },
      ...forbidden,
      ...conflict,
      ...unavailable,
    },
  }),
  listImportRows: defineRoute({
    ...base,
    method: 'get',
    path: '/v1/imports/{id}/rows',
    operationId: 'listImportRows',
    summary: 'Row outcomes (failed and skipped rows with their errors)',
    request: { params: IdParam, query: ImportRowsQuery },
    responses: {
      200: {
        description: 'Rows',
        body: z.object({ items: z.array(ImportRowDto), next: z.number().int().nullable() }),
      },
      ...forbidden,
    },
  }),
  importResults: defineRoute({
    ...base,
    method: 'get',
    path: '/v1/imports/{id}/results',
    operationId: 'getImportResults',
    summary: 'A short-lived URL to download the results file (CSV)',
    request: { params: IdParam },
    responses: {
      200: {
        description: 'Download URL',
        body: z.object({ url: z.url(), expiresAt: z.iso.datetime() }),
      },
      ...forbidden,
      ...conflict,
      ...unavailable,
    },
  }),
  listImportTemplates: defineRoute({
    ...base,
    method: 'get',
    path: '/v1/import-templates',
    operationId: 'listImportTemplates',
    summary: 'Saved mapping templates',
    request: { query: z.object({ object: z.string().max(80).optional() }).strict() },
    responses: {
      200: { description: 'Templates', body: z.object({ items: z.array(ImportTemplateDto) }) },
      ...forbidden,
    },
  }),
  createImportTemplate: defineRoute({
    ...base,
    method: 'post',
    path: '/v1/import-templates',
    operationId: 'createImportTemplate',
    summary: 'Save a mapping for files with these headers',
    request: { body: CreateImportTemplateRequest },
    responses: {
      201: { description: 'The template', body: ImportTemplateDto },
      ...forbidden,
      409: { description: 'A template with this name exists' },
    },
  }),
  deleteImportTemplate: defineRoute({
    ...base,
    method: 'delete',
    path: '/v1/import-templates/{id}',
    operationId: 'deleteImportTemplate',
    summary: 'Delete a mapping template',
    request: { params: IdParam },
    responses: { 204: { description: 'Deleted' }, ...forbidden },
  }),
};
