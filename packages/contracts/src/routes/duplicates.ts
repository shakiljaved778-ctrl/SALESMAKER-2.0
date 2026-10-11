import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { Uuid } from '../primitives.js';
import { setupCrud } from './setup.js';

const FieldName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'Must be a field API name');
const Name = z.string().trim().min(1).max(80);
const Version = z.number().int().positive();
export const DedupeObject = z.enum(['lead', 'contact', 'account']);

// ── Matching and duplicate rules (§7.2) ─────────────────────────────────────────────────────
export const MatchConditionDto = z
  .object({
    field: FieldName,
    method: z.enum(['exact', 'fuzzy', 'phone', 'email', 'email_domain_name', 'company']),
    /** Fuzzy only: the similarity a pair must reach (0.3–1, default 0.8). */
    threshold: z.number().min(0.3).max(1).optional(),
  })
  .strict()
  .meta({ id: 'MatchCondition' });

export const MatchingRuleDto = z
  .object({
    id: Uuid,
    object: DedupeObject,
    name: z.string(),
    active: z.boolean(),
    /** Blank values match each other (off: a blank never matches). */
    matchBlank: z.boolean(),
    conditions: z.array(MatchConditionDto),
    /** Duplicate rules using it. */
    usedBy: z.number().int(),
    version: z.number().int(),
  })
  .meta({ id: 'MatchingRule' });

export const CreateMatchingRuleRequest = z
  .object({
    object: DedupeObject,
    name: Name,
    active: z.boolean().default(true),
    matchBlank: z.boolean().default(false),
    conditions: z.array(MatchConditionDto).min(1).max(10),
  })
  .strict();
export const UpdateMatchingRuleRequest = z
  .object({
    name: Name.optional(),
    active: z.boolean().optional(),
    matchBlank: z.boolean().optional(),
    conditions: z.array(MatchConditionDto).min(1).max(10).optional(),
    version: Version,
  })
  .strict();

export const DuplicateRuleDto = z
  .object({
    id: Uuid,
    object: DedupeObject,
    name: z.string(),
    matchingRule: z.object({ id: Uuid, name: z.string() }),
    action: z.enum(['BLOCK', 'ALERT']),
    onCreate: z.boolean(),
    onEdit: z.boolean(),
    /** Profiles whose users may save past a Block. */
    bypassProfileIds: z.array(Uuid),
    active: z.boolean(),
    sortOrder: z.number().int(),
    version: z.number().int(),
  })
  .meta({ id: 'DuplicateRule' });

export const CreateDuplicateRuleRequest = z
  .object({
    object: DedupeObject,
    name: Name,
    matchingRuleId: Uuid,
    action: z.enum(['BLOCK', 'ALERT']).default('ALERT'),
    onCreate: z.boolean().default(true),
    onEdit: z.boolean().default(true),
    bypassProfileIds: z.array(Uuid).max(50).default([]),
    active: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(1000).default(0),
  })
  .strict();
export const UpdateDuplicateRuleRequest = z
  .object({
    name: Name.optional(),
    matchingRuleId: Uuid.optional(),
    action: z.enum(['BLOCK', 'ALERT']).optional(),
    onCreate: z.boolean().optional(),
    onEdit: z.boolean().optional(),
    bypassProfileIds: z.array(Uuid).max(50).optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    version: Version,
  })
  .strict();

// ── Checks and potential duplicates ─────────────────────────────────────────────────────────
export const DuplicateGroupDto = z
  .object({
    ruleId: Uuid,
    rule: z.string(),
    action: z.enum(['BLOCK', 'ALERT']),
    /** Matches the caller can see, best first (at most ten). */
    matches: z.array(z.object({ id: Uuid, name: z.string().nullable(), score: z.number() })),
  })
  .meta({ id: 'DuplicateGroup' });

export const DuplicateCheckResult = z
  .object({
    /** A Block rule would refuse this save (whether or not its matches are visible). */
    blocked: z.boolean(),
    groups: z.array(DuplicateGroupDto),
  })
  .meta({ id: 'DuplicateCheck' });

export const DuplicateCheckRequest = z
  .object({
    /** Field values as typed so far (unknown and unreadable fields are ignored). */
    fields: z.record(FieldName, z.unknown()),
    /** The record being edited, if any: its stored values fill the rest, and it never matches itself. */
    id: Uuid.optional(),
  })
  .strict();

export const TestMatchingRuleRequest = z
  .object({ recordId: Uuid.optional(), fields: z.record(FieldName, z.unknown()).optional() })
  .strict()
  .refine((v) => (v.recordId === undefined) !== (v.fields === undefined), {
    message: 'Give either recordId or fields',
  });

export const MatchingRuleTestResult = z
  .object({
    matches: z.array(z.object({ id: Uuid, name: z.string().nullable(), score: z.number() })),
  })
  .meta({ id: 'MatchingRuleTest' });

const DedupeObjectParam = z.object({ object: DedupeObject });
const DedupeRecordParam = z.object({ object: DedupeObject, id: Uuid });
const forbidden = { 403: { description: 'The caller lacks the required system permission' } };

/** Live checks while typing, and the record page's potential duplicates (§7.2, §7.5). */
export const duplicateRoutes = {
  checkDuplicates: defineRoute({
    method: 'post',
    path: '/v1/records/{object}/duplicates/check',
    operationId: 'checkDuplicates',
    summary: 'Run the duplicate rules on values being typed, before saving',
    tags: ['records'],
    auth: 'session',
    visibility: 'internal',
    request: { params: DedupeObjectParam, body: DuplicateCheckRequest },
    responses: { 200: { description: 'What the rules found', body: DuplicateCheckResult } },
  }),
  listRecordDuplicates: defineRoute({
    method: 'get',
    path: '/v1/records/{object}/{id}/duplicates',
    operationId: 'listRecordDuplicates',
    summary: 'Potential duplicates of a record under the active duplicate rules',
    tags: ['records'],
    auth: 'session',
    visibility: 'internal',
    request: { params: DedupeRecordParam },
    responses: {
      200: {
        description: 'Matches by rule',
        body: z.object({ groups: z.array(DuplicateGroupDto) }),
      },
    },
  }),
};

/** Setup → Duplicate management. Reading needs view_setup, changes customize_application. */
export const dedupeSetupRoutes = {
  ...setupCrud(
    '/v1/setup/matching-rules',
    'setup',
    'matching rule',
    {
      list: 'listMatchingRules',
      get: 'getMatchingRule',
      create: 'createMatchingRule',
      update: 'updateMatchingRule',
      remove: 'deleteMatchingRule',
    },
    {
      item: MatchingRuleDto,
      detail: MatchingRuleDto,
      create: CreateMatchingRuleRequest,
      update: UpdateMatchingRuleRequest,
    },
  ),
  testMatchingRule: defineRoute({
    method: 'post',
    path: '/v1/setup/matching-rules/{id}/test',
    operationId: 'testMatchingRule',
    summary: 'Preview what a matching rule finds for a record or for typed values',
    tags: ['setup'],
    auth: 'session',
    visibility: 'internal',
    request: { params: z.object({ id: Uuid }), body: TestMatchingRuleRequest },
    responses: { 200: { description: 'Matches', body: MatchingRuleTestResult }, ...forbidden },
  }),
  ...setupCrud(
    '/v1/setup/duplicate-rules',
    'setup',
    'duplicate rule',
    {
      list: 'listDuplicateRules',
      get: 'getDuplicateRule',
      create: 'createDuplicateRule',
      update: 'updateDuplicateRule',
      remove: 'deleteDuplicateRule',
    },
    {
      item: DuplicateRuleDto,
      detail: DuplicateRuleDto,
      create: CreateDuplicateRuleRequest,
      update: UpdateDuplicateRuleRequest,
    },
  ),
};
