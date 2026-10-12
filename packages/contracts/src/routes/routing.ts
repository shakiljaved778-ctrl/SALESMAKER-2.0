import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { Uuid } from '../primitives.js';
import { setupCrud } from './setup.js';

const Name = z.string().trim().min(1).max(80);
const Version = z.number().int().positive();
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Must be HH:MM');

/** Open intervals per weekday, local to a time zone: `{ mon: [["08:00","17:00"]] }`. */
const Day = z
  .array(z.tuple([Time, Time]))
  .max(6)
  .optional();
export const WeeklyHoursDto = z
  .object({ sun: Day, mon: Day, tue: Day, wed: Day, thu: Day, fri: Day, sat: Day })
  .strict()
  .meta({ id: 'WeeklyHours' });

const IsoDate = z.iso.date();
export const HolidayDto = z
  .object({ date: IsoDate, name: Name, recurring: z.boolean().default(false) })
  .strict()
  .meta({ id: 'Holiday' });

export const BusinessHoursDto = z
  .object({
    id: Uuid,
    name: z.string(),
    timezone: z.string(),
    hours: WeeklyHoursDto,
    isDefault: z.boolean(),
    active: z.boolean(),
    holidays: z.array(HolidayDto),
    version: z.number().int(),
  })
  .meta({ id: 'BusinessHours' });

export const CreateBusinessHoursRequest = z
  .object({
    name: Name,
    /** An IANA time zone, e.g. Asia/Qatar. */
    timezone: z.string().min(1).max(64),
    hours: WeeklyHoursDto,
    isDefault: z.boolean().default(false),
    active: z.boolean().default(true),
    holidays: z.array(HolidayDto).max(366).default([]),
  })
  .strict();
export const UpdateBusinessHoursRequest = z
  .object({
    name: Name.optional(),
    timezone: z.string().min(1).max(64).optional(),
    hours: WeeklyHoursDto.optional(),
    isDefault: z.boolean().optional(),
    active: z.boolean().optional(),
    /** Replaces the holidays when given. */
    holidays: z.array(HolidayDto).max(366).optional(),
    version: Version,
  })
  .strict();

// ── Users' routing settings (§7.3) ──────────────────────────────────────────────────────────
const Skill = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_:-]*$/, 'Lowercase letters, digits, _ : and -');

export const UserRoutingDto = z
  .object({
    userId: Uuid,
    availability: z.object({
      /** Null: available whenever the user is not out of office. */
      workingHours: WeeklyHoursDto.nullable(),
      outOfOffice: z.boolean(),
      /** Out of office ends on its own at this instant. */
      oooUntil: z.iso.datetime().nullable(),
    }),
    skills: z.array(z.string()),
    capacity: z.array(
      z.object({
        object: z.string(),
        maxOpen: z.number().int().nullable(),
        maxNewPerDay: z.number().int().nullable(),
      }),
    ),
  })
  .meta({ id: 'UserRouting' });

export const PutUserRoutingRequest = z
  .object({
    availability: z
      .object({
        workingHours: WeeklyHoursDto.nullable(),
        outOfOffice: z.boolean(),
        oooUntil: z.iso.datetime().nullable().optional(),
      })
      .strict()
      .optional(),
    /** Replaces the skills (administrators only). */
    skills: z.array(Skill).max(50).optional(),
    /** Replaces the per-object limits (administrators only). */
    capacity: z
      .array(
        z
          .object({
            object: z.enum(['lead', 'opportunity', 'contact', 'account']),
            maxOpen: z.number().int().min(0).max(100_000).nullable(),
            maxNewPerDay: z.number().int().min(0).max(10_000).nullable(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();

const forbidden = { 403: { description: 'The caller lacks the required system permission' } };

export const routingRoutes = {
  ...setupCrud(
    '/v1/setup/business-hours',
    'setup',
    'business hours set',
    {
      list: 'listBusinessHours',
      get: 'getBusinessHours',
      create: 'createBusinessHours',
      update: 'updateBusinessHours',
      remove: 'deleteBusinessHours',
    },
    {
      item: BusinessHoursDto,
      detail: BusinessHoursDto,
      create: CreateBusinessHoursRequest,
      update: UpdateBusinessHoursRequest,
    },
  ),
  getUserRouting: defineRoute({
    method: 'get',
    path: '/v1/users/{id}/routing',
    operationId: 'getUserRouting',
    summary: 'A user’s working hours, out of office, skills and capacity (themself, or view_setup)',
    tags: ['users'],
    auth: 'session',
    visibility: 'internal',
    request: { params: z.object({ id: Uuid }) },
    responses: { 200: { description: 'Routing settings', body: UserRoutingDto }, ...forbidden },
  }),
  putUserRouting: defineRoute({
    method: 'put',
    path: '/v1/users/{id}/routing',
    operationId: 'putUserRouting',
    summary: 'Change routing settings: users their own availability, manage_users everything',
    tags: ['users'],
    auth: 'session',
    visibility: 'internal',
    request: { params: z.object({ id: Uuid }), body: PutUserRoutingRequest },
    responses: { 200: { description: 'Routing settings', body: UserRoutingDto }, ...forbidden },
  }),
};

// ── Assignment rules (§7.3) ─────────────────────────────────────────────────────────────────
export const AssignmentMethodEnum = z.enum([
  'ROUND_ROBIN',
  'WEIGHTED',
  'LOAD_BALANCED',
  'SKILLS_BASED',
  'STICKY_ACCOUNT',
  'QUEUE',
  'SPECIFIC_USER',
]);
const AssignmentObject = z.enum(['lead', 'contact', 'account', 'opportunity']);

export const PoolMemberDto = z
  .object({
    type: z.enum(['USER', 'QUEUE', 'ORG_UNIT']),
    id: Uuid,
    /** WEIGHTED: relative share. */
    weight: z.number().int().min(1).max(1000).default(1),
  })
  .strict()
  .meta({ id: 'PoolMember' });

export const EntrySettingsDto = z
  .object({
    openCategories: z.array(z.string().max(40)).max(10).optional(),
    skills: z.array(z.string().max(40)).max(20).optional(),
    skillField: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/)
      .optional(),
    fallback: z
      .object({ type: z.enum(['USER', 'QUEUE']), id: Uuid })
      .strict()
      .optional(),
  })
  .strict()
  .meta({ id: 'AssignmentEntrySettings' });

export const AssignmentEntryDto = z
  .object({
    name: z.string().trim().max(80).nullable().optional(),
    /** A filter tree over the record's fields (same shape as list view filters). */
    criteria: z.unknown().optional(),
    /** A Boolean formula; with criteria, both must hold. Neither: every record matches. */
    formula: z.string().max(3900).nullable().optional(),
    method: AssignmentMethodEnum,
    settings: EntrySettingsDto.default({}),
    targetUserId: Uuid.nullable().optional(),
    targetQueueId: Uuid.nullable().optional(),
    active: z.boolean().default(true),
    members: z.array(PoolMemberDto).max(500).default([]),
  })
  .strict()
  .meta({ id: 'AssignmentEntry' });

export const AssignmentRuleDto = z
  .object({
    id: Uuid,
    object: AssignmentObject,
    name: z.string(),
    active: z.boolean(),
    isDefault: z.boolean(),
    entries: z.array(AssignmentEntryDto.extend({ id: Uuid })),
    version: z.number().int(),
  })
  .meta({ id: 'AssignmentRule' });

export const CreateAssignmentRuleRequest = z
  .object({
    object: AssignmentObject,
    name: Name,
    active: z.boolean().default(true),
    isDefault: z.boolean().default(false),
    entries: z.array(AssignmentEntryDto).max(50).default([]),
  })
  .strict();
export const UpdateAssignmentRuleRequest = z
  .object({
    name: Name.optional(),
    active: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    /** Replaces the entries (their turns start afresh). */
    entries: z.array(AssignmentEntryDto).max(50).optional(),
    version: Version,
  })
  .strict();

export const RunAssignmentRequest = z
  .object({
    object: AssignmentObject,
    recordIds: z.array(Uuid).min(1).max(200),
    /** A rule other than the object's default. */
    ruleId: Uuid.optional(),
  })
  .strict();

export const AssignmentOutcomeDto = z
  .object({
    recordId: Uuid,
    ok: z.boolean(),
    /** When ok: the owner chosen (or kept) and why; absent when no entry matched. */
    ownerType: z.enum(['USER', 'QUEUE']).optional(),
    ownerId: Uuid.optional(),
    method: AssignmentMethodEnum.nullable().optional(),
    reason: z.string().optional(),
    changed: z.boolean().optional(),
    /** When not ok: why the caller may not reassign the record. */
    error: z.enum(['not_found', 'forbidden']).optional(),
  })
  .meta({ id: 'AssignmentOutcome' });

export const AssignmentLogDto = z
  .object({
    id: Uuid,
    assignedAt: z.iso.datetime(),
    method: AssignmentMethodEnum.nullable(),
    owner: z.object({ type: z.enum(['USER', 'QUEUE']), id: Uuid, name: z.string().nullable() }),
    previousOwnerId: Uuid.nullable(),
    reason: z.string(),
    source: z.string(),
    rule: z.object({ id: Uuid, name: z.string().nullable() }).nullable(),
    candidates: z.array(
      z.object({ userId: Uuid, name: z.string().nullable(), skipped: z.string().optional() }),
    ),
  })
  .meta({ id: 'AssignmentLogEntry' });

export const assignmentRoutes = {
  ...setupCrud(
    '/v1/setup/assignment-rules',
    'setup',
    'assignment rule',
    {
      list: 'listAssignmentRules',
      get: 'getAssignmentRule',
      create: 'createAssignmentRule',
      update: 'updateAssignmentRule',
      remove: 'deleteAssignmentRule',
    },
    {
      item: AssignmentRuleDto,
      detail: AssignmentRuleDto,
      create: CreateAssignmentRuleRequest,
      update: UpdateAssignmentRuleRequest,
    },
  ),
  runAssignment: defineRoute({
    method: 'post',
    path: '/v1/assignment/run',
    operationId: 'runAssignment',
    summary: 'Run an assignment rule on records (transfer_records and Full access on each)',
    tags: ['records'],
    auth: 'session',
    visibility: 'internal',
    request: { body: RunAssignmentRequest },
    responses: {
      200: {
        description: 'Per record',
        body: z.object({ results: z.array(AssignmentOutcomeDto) }),
      },
      ...forbidden,
    },
  }),
  recordAssignment: defineRoute({
    method: 'get',
    path: '/v1/records/{object}/{id}/assignment',
    operationId: 'getRecordAssignment',
    summary: '"Why was this assigned to me?": the record’s assignment decisions, latest first',
    tags: ['records'],
    auth: 'session',
    visibility: 'internal',
    request: { params: z.object({ object: AssignmentObject, id: Uuid }) },
    responses: {
      200: { description: 'Decisions', body: z.object({ items: z.array(AssignmentLogDto) }) },
    },
  }),
};

// ── Queue pick-up (§7.3) ────────────────────────────────────────────────────────────────────
export const MyQueueDto = z
  .object({
    id: Uuid,
    name: z.string(),
    objects: z.array(z.string()),
    /** Records waiting in the queue, per object. */
    waiting: z.record(z.string(), z.number().int()),
  })
  .meta({ id: 'MyQueue' });

export const TakeNextRequest = z.object({ object: AssignmentObject }).strict();
export const TakenDto = z
  .object({
    /** The record now owned by the caller; null when the queue was empty. */
    id: Uuid.nullable(),
    object: AssignmentObject,
  })
  .meta({ id: 'Taken' });

export const queueRoutes = {
  listMyQueues: defineRoute({
    method: 'get',
    path: '/v1/queues/mine',
    operationId: 'listMyQueues',
    summary: 'Queues the caller belongs to, with what waits in them',
    tags: ['records'],
    auth: 'session',
    visibility: 'internal',
    responses: { 200: { description: 'Queues', body: z.object({ items: z.array(MyQueueDto) }) } },
  }),
  takeNext: defineRoute({
    method: 'post',
    path: '/v1/queues/{id}/take-next',
    operationId: 'takeNext',
    summary: 'Take the queue’s next record (highest score, then oldest) that nobody else is taking',
    tags: ['records'],
    auth: 'session',
    visibility: 'internal',
    request: { params: z.object({ id: Uuid }), body: TakeNextRequest },
    responses: {
      200: { description: 'The record taken, if any', body: TakenDto },
      403: { description: 'Not a member of the queue' },
    },
  }),
  acceptRecord: defineRoute({
    method: 'post',
    path: '/v1/records/{object}/{id}/accept',
    operationId: 'acceptRecord',
    summary: 'Take a record a queue of the caller owns',
    tags: ['records'],
    auth: 'session',
    visibility: 'internal',
    request: { params: z.object({ object: AssignmentObject, id: Uuid }) },
    responses: {
      200: { description: 'Taken', body: TakenDto },
      403: { description: 'Not a member of the owning queue' },
      409: { description: 'No queue owns the record any more (someone took it)' },
    },
  }),
};

// ── SLA policies and timers (§7.3) ──────────────────────────────────────────────────────────
const Percent = z.number().int();
export const SlaPolicyDto = z
  .object({
    id: Uuid,
    object: z.literal('lead'),
    name: z.string(),
    metric: z.enum(['FIRST_TOUCH', 'QUALIFY']),
    targetMinutes: z.number().int(),
    businessHoursId: Uuid.nullable(),
    ownerTimezone: z.boolean(),
    criteria: z.unknown().optional(),
    warnAtPercent: Percent.nullable(),
    managerAtPercent: Percent.nullable(),
    reassignAtPercent: Percent.nullable(),
    reassignRuleId: Uuid.nullable(),
    active: z.boolean(),
    sortOrder: z.number().int(),
    version: z.number().int(),
  })
  .meta({ id: 'SlaPolicy' });

const SlaFields = {
  metric: z.enum(['FIRST_TOUCH', 'QUALIFY']),
  /** Minutes of (business) time to the target. */
  targetMinutes: z.number().int().min(1).max(525_600),
  businessHoursId: Uuid.nullable(),
  ownerTimezone: z.boolean(),
  criteria: z.unknown().nullable(),
  warnAtPercent: z.number().int().min(1).max(99).nullable(),
  managerAtPercent: z.number().int().min(1).max(500).nullable(),
  reassignAtPercent: z.number().int().min(1).max(500).nullable(),
  reassignRuleId: Uuid.nullable(),
  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(1000),
};
export const CreateSlaPolicyRequest = z
  .object({
    object: z.literal('lead').default('lead'),
    name: Name,
    metric: SlaFields.metric,
    targetMinutes: SlaFields.targetMinutes,
    businessHoursId: SlaFields.businessHoursId.default(null),
    ownerTimezone: SlaFields.ownerTimezone.default(false),
    criteria: SlaFields.criteria.optional(),
    warnAtPercent: SlaFields.warnAtPercent.default(50),
    managerAtPercent: SlaFields.managerAtPercent.default(100),
    reassignAtPercent: SlaFields.reassignAtPercent.default(null),
    reassignRuleId: SlaFields.reassignRuleId.default(null),
    active: SlaFields.active.default(true),
    sortOrder: SlaFields.sortOrder.default(0),
  })
  .strict();
export const UpdateSlaPolicyRequest = z
  .object({
    name: Name.optional(),
    metric: SlaFields.metric.optional(),
    targetMinutes: SlaFields.targetMinutes.optional(),
    businessHoursId: SlaFields.businessHoursId.optional(),
    ownerTimezone: SlaFields.ownerTimezone.optional(),
    criteria: SlaFields.criteria.optional(),
    warnAtPercent: SlaFields.warnAtPercent.optional(),
    managerAtPercent: SlaFields.managerAtPercent.optional(),
    reassignAtPercent: SlaFields.reassignAtPercent.optional(),
    reassignRuleId: SlaFields.reassignRuleId.optional(),
    active: SlaFields.active.optional(),
    sortOrder: SlaFields.sortOrder.optional(),
    version: Version,
  })
  .strict();

export const SlaTimerDto = z
  .object({
    id: Uuid,
    policy: z.object({ id: Uuid, name: z.string(), metric: z.enum(['FIRST_TOUCH', 'QUALIFY']) }),
    ownerId: Uuid,
    startedAt: z.iso.datetime(),
    warnAt: z.iso.datetime().nullable(),
    dueAt: z.iso.datetime(),
    metAt: z.iso.datetime().nullable(),
    breachedAt: z.iso.datetime().nullable(),
    status: z.enum(['RUNNING', 'MET', 'BREACHED', 'CANCELLED']),
    /** For chips: running and past the warning point is at risk. */
    state: z.enum(['on_track', 'at_risk', 'breached', 'met', 'cancelled']),
  })
  .meta({ id: 'SlaTimer' });

export const SlaStatusRequest = z
  .object({ object: z.literal('lead'), ids: z.array(Uuid).min(1).max(200) })
  .strict();

const LeadParam = z.object({ id: Uuid });
export const slaRoutes = {
  ...setupCrud(
    '/v1/setup/sla-policies',
    'setup',
    'SLA policy',
    {
      list: 'listSlaPolicies',
      get: 'getSlaPolicy',
      create: 'createSlaPolicy',
      update: 'updateSlaPolicy',
      remove: 'deleteSlaPolicy',
    },
    {
      item: SlaPolicyDto,
      detail: SlaPolicyDto,
      create: CreateSlaPolicyRequest,
      update: UpdateSlaPolicyRequest,
    },
  ),
  touchLead: defineRoute({
    method: 'post',
    path: '/v1/records/lead/{id}/touch',
    operationId: 'touchLead',
    summary: 'Record a first touch on a lead (stops its first-touch SLA clocks)',
    tags: ['records'],
    auth: 'session',
    visibility: 'internal',
    request: { params: LeadParam },
    responses: {
      200: { description: 'Clocks stopped', body: z.object({ met: z.number().int() }) },
      403: { description: 'Edit access to the lead is needed' },
    },
  }),
  recordSla: defineRoute({
    method: 'get',
    path: '/v1/records/lead/{id}/sla',
    operationId: 'getLeadSla',
    summary: 'A lead’s SLA clocks',
    tags: ['records'],
    auth: 'session',
    visibility: 'internal',
    request: { params: LeadParam },
    responses: { 200: { description: 'Clocks', body: z.object({ items: z.array(SlaTimerDto) }) } },
  }),
  slaStatus: defineRoute({
    method: 'post',
    path: '/v1/sla/status',
    operationId: 'slaStatus',
    summary: 'SLA chips for a page of records (only records the caller can see)',
    tags: ['records'],
    auth: 'session',
    visibility: 'internal',
    request: { body: SlaStatusRequest },
    responses: {
      200: {
        description: 'Clocks per record',
        body: z.object({
          items: z.array(z.object({ recordId: Uuid, timers: z.array(SlaTimerDto) })),
        }),
      },
    },
  }),
};
