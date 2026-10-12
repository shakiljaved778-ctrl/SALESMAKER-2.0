import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { Uuid } from '../primitives.js';
import { setupCrud } from './setup.js';

const Name = z.string().trim().min(1).max(80);

export const ScoringRuleDto = z
  .object({
    kind: z.enum(['FIT', 'ENGAGEMENT']),
    name: Name,
    /** FIT: a Boolean formula over the lead. */
    formula: z.string().max(3900).nullable().optional(),
    /** ENGAGEMENT: the event counted. */
    event: z.enum(['form_submission', 'inbound_email']).nullable().optional(),
    points: z.number().int().min(-100).max(100),
    active: z.boolean().default(true),
  })
  .strict()
  .meta({ id: 'ScoringRule' });

const GradeBands = z
  .object({
    A: z.number().int().min(1).max(100),
    B: z.number().int().min(1).max(100),
    C: z.number().int().min(1).max(100),
  })
  .strict()
  .refine((b) => b.A > b.B && b.B > b.C, { message: 'A above B above C' });

export const ScoringModelDto = z
  .object({
    id: Uuid,
    object: z.literal('lead'),
    name: z.string(),
    active: z.boolean(),
    /** The model that writes the lead's score fields. */
    isPrimary: z.boolean(),
    fitWeight: z.number().int(),
    engagementHalfLifeDays: z.number().int(),
    gradeBands: z.object({ A: z.number(), B: z.number(), C: z.number() }),
    rules: z.array(ScoringRuleDto.extend({ id: Uuid })),
    version: z.number().int(),
  })
  .meta({ id: 'ScoringModel' });

export const CreateScoringModelRequest = z
  .object({
    object: z.literal('lead').default('lead'),
    name: Name,
    active: z.boolean().default(true),
    isPrimary: z.boolean().default(false),
    fitWeight: z.number().int().min(0).max(100).default(60),
    engagementHalfLifeDays: z.number().int().min(1).max(365).default(14),
    gradeBands: GradeBands.default({ A: 75, B: 50, C: 25 }),
    rules: z.array(ScoringRuleDto).max(100).default([]),
  })
  .strict();
export const UpdateScoringModelRequest = z
  .object({
    name: Name.optional(),
    active: z.boolean().optional(),
    isPrimary: z.boolean().optional(),
    fitWeight: z.number().int().min(0).max(100).optional(),
    engagementHalfLifeDays: z.number().int().min(1).max(365).optional(),
    gradeBands: GradeBands.optional(),
    /** Replaces the rules. */
    rules: z.array(ScoringRuleDto).max(100).optional(),
    version: z.number().int().positive(),
  })
  .strict();

export const ScoreHistoryDto = z
  .object({
    changedAt: z.iso.datetime(),
    fit: z.number().int(),
    engagement: z.number().int(),
    score: z.number().int(),
    grade: z.string(),
    /** The rules that matched and the events counted. */
    reason: z.array(z.string()),
  })
  .meta({ id: 'ScoreHistoryEntry' });

export const scoringRoutes = {
  ...setupCrud(
    '/v1/setup/scoring-models',
    'setup',
    'scoring model',
    {
      list: 'listScoringModels',
      get: 'getScoringModel',
      create: 'createScoringModel',
      update: 'updateScoringModel',
      remove: 'deleteScoringModel',
    },
    {
      item: ScoringModelDto,
      detail: ScoringModelDto,
      create: CreateScoringModelRequest,
      update: UpdateScoringModelRequest,
    },
  ),
  leadScoreHistory: defineRoute({
    method: 'get',
    path: '/v1/records/lead/{id}/score-history',
    operationId: 'getLeadScoreHistory',
    summary: 'How a lead’s score moved, latest first (up to 50)',
    tags: ['records'],
    auth: 'session',
    visibility: 'internal',
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: { description: 'Changes', body: z.object({ items: z.array(ScoreHistoryDto) }) },
    },
  }),
};
