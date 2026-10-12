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
