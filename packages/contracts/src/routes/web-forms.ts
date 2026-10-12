import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { Uuid } from '../primitives.js';
import { setupCrud } from './setup.js';

/*
 * Web-to-lead forms (§7.1): Setup defines them; a public endpoint per cell serves the form and
 * takes submissions. Submissions are stored before processing and run as the form's run-as user.
 */

const FieldValue = z.union([
  z.string().max(4000),
  z.number(),
  z.boolean(),
  z.array(z.string().max(255)).max(100),
  z.null(),
]);

export const WebFormFieldDto = z
  .object({
    /** Field API name on the lead. */
    field: z.string().min(1).max(80),
    /** Shown instead of the field's label. */
    label: z.string().trim().max(200).nullable().default(null),
    required: z.boolean().default(false),
    /** Not shown: always takes `defaultValue`. */
    hidden: z.boolean().default(false),
    defaultValue: FieldValue.default(null),
    /** Picklists: the values offered (empty: every active value). */
    values: z.array(z.string().max(255)).max(500).default([]),
  })
  .strict()
  .meta({ id: 'WebFormField' });

export const WebFormConsentDto = z
  .object({
    /** Stable key the submission's consents are recorded under. */
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    text: z.string().trim().min(1).max(2000),
    required: z.boolean().default(false),
  })
  .strict();

export const WebFormSettingsDto = z
  .object({
    theme: z.enum(['light', 'dark', 'auto']).default('auto'),
    /** Null: the localised default ("Submit"). */
    buttonLabel: z.string().trim().min(1).max(40).nullable().default(null),
    thankYouMessage: z.string().trim().max(1000).nullable().default(null),
    /** Where the visitor goes after submitting (https only); else the thank-you message. */
    redirectUrl: z
      .url({ protocol: /^https$/ })
      .max(2000)
      .nullable()
      .default(null),
    consents: z.array(WebFormConsentDto).max(5).default([]),
    /** Cloudflare Turnstile; only when this cell has keys. */
    turnstile: z.boolean().default(false),
    /** Email domains refused besides the built-in disposable list. */
    blockedDomains: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/),
      )
      .max(500)
      .default([]),
  })
  .strict()
  .meta({ id: 'WebFormSettings' });

const AutoResponder = z
  .object({
    subject: z.string().trim().min(1).max(200),
    /** Plain text; `{first_name}` and `{last_name}` are replaced. */
    body: z.string().trim().min(1).max(5000),
  })
  .strict();

const FormStatus = z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']);

export const WebFormDto = z
  .object({
    id: Uuid,
    name: z.string(),
    object: z.literal('lead'),
    status: FormStatus,
    runAsUser: z.object({ id: Uuid, name: z.string() }),
    fields: z.array(WebFormFieldDto),
    settings: WebFormSettingsDto,
    defaults: z.record(z.string(), FieldValue),
    assignmentRuleId: Uuid.nullable(),
    autoResponder: AutoResponder.nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'WebForm' });

const Name = z.string().trim().min(1).max(120);
const Fields = z
  .array(WebFormFieldDto)
  .max(50)
  .refine((fs) => new Set(fs.map((f) => f.field)).size === fs.length, {
    message: 'Each field once',
  });

export const CreateWebFormRequest = z
  .object({
    name: Name,
    object: z.literal('lead').default('lead'),
    status: FormStatus.default('DRAFT'),
    /** The user submissions are created as (an integration user with lead create). */
    runAsUserId: Uuid,
    fields: Fields.default([]),
    settings: WebFormSettingsDto.default(WebFormSettingsDto.parse({})),
    defaults: z.record(z.string().max(80), FieldValue).default({}),
    assignmentRuleId: Uuid.nullable().default(null),
    autoResponder: AutoResponder.nullable().default(null),
  })
  .strict();

export const UpdateWebFormRequest = z
  .object({
    name: Name.optional(),
    status: FormStatus.optional(),
    runAsUserId: Uuid.optional(),
    fields: Fields.optional(),
    settings: WebFormSettingsDto.optional(),
    defaults: z.record(z.string().max(80), FieldValue).optional(),
    assignmentRuleId: Uuid.nullable().optional(),
    autoResponder: AutoResponder.nullable().optional(),
    version: z.number().int().positive(),
  })
  .strict();

const SubmissionStatus = z.enum(['RECEIVED', 'CREATED', 'DUPLICATE', 'REJECTED', 'FAILED']);

export const WebFormSubmissionDto = z
  .object({
    id: Uuid,
    receivedAt: z.iso.datetime(),
    status: SubmissionStatus,
    /** The lead created, or the existing lead a duplicate rule matched. */
    recordId: Uuid.nullable(),
    reason: z.string().nullable(),
    /** UTM, referrer, landing page and click ids (never the visitor's values or IP). */
    meta: z.record(z.string(), z.string()),
  })
  .meta({ id: 'WebFormSubmission' });

// ── Public (unauthenticated) ────────────────────────────────────────────────

export const PublicFormParams = z.object({ tenantId: Uuid, formId: Uuid });

export const PublicWebFormDto = z
  .object({
    id: Uuid,
    name: z.string(),
    fields: z.array(
      z.object({
        name: z.string(),
        label: z.string(),
        type: z.string(),
        required: z.boolean(),
        maxLength: z.number().int().nullable(),
        options: z.array(z.object({ value: z.string(), label: z.string() })),
      }),
    ),
    theme: z.enum(['light', 'dark', 'auto']),
    buttonLabel: z.string().nullable(),
    consents: z.array(z.object({ key: z.string(), text: z.string(), required: z.boolean() })),
    /** Present when the form asks for a Turnstile token. */
    turnstileSiteKey: z.string().nullable(),
  })
  .meta({ id: 'PublicWebForm' });

const Clipped = z.string().max(4000).optional();

export const SubmitWebFormRequest = z
  .object({
    fields: z.record(z.string().max(80), FieldValue).default({}),
    consents: z.record(z.string().max(40), z.boolean()).default({}),
    /** Honeypot: hidden from people; anything here marks a bot. */
    website: z.string().max(2000).optional(),
    turnstileToken: z.string().max(2048).optional(),
    context: z
      .object({
        utmSource: Clipped,
        utmMedium: Clipped,
        utmCampaign: Clipped,
        utmTerm: Clipped,
        utmContent: Clipped,
        referrer: Clipped,
        landingPage: Clipped,
        gclid: Clipped,
        fbclid: Clipped,
      })
      .strict()
      .default({}),
  })
  .strict();

export const SubmitWebFormResponse = z
  .object({
    status: z.literal('received'),
    message: z.string().nullable(),
    redirectUrl: z.string().nullable(),
  })
  .meta({ id: 'WebFormSubmitted' });

export const webFormRoutes = {
  ...setupCrud(
    '/v1/setup/web-forms',
    'setup',
    'web form',
    {
      list: 'listWebForms',
      get: 'getWebForm',
      create: 'createWebForm',
      update: 'updateWebForm',
      remove: 'deleteWebForm',
    },
    {
      item: WebFormDto,
      detail: WebFormDto,
      create: CreateWebFormRequest,
      update: UpdateWebFormRequest,
    },
  ),
  listWebFormSubmissions: defineRoute({
    method: 'get',
    path: '/v1/setup/web-forms/{id}/submissions',
    operationId: 'listWebFormSubmissions',
    summary: 'A form’s submissions, newest first',
    tags: ['setup'],
    auth: 'session',
    visibility: 'internal',
    request: {
      params: z.object({ id: Uuid }),
      query: z
        .object({
          status: SubmissionStatus.optional(),
          /** Submissions received before this one (keyset). */
          before: Uuid.optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .strict(),
    },
    responses: {
      200: {
        description: 'Submissions',
        body: z.object({ items: z.array(WebFormSubmissionDto), next: Uuid.nullable() }),
      },
      403: { description: 'The caller lacks view_setup' },
    },
  }),
  getPublicWebForm: defineRoute({
    method: 'get',
    path: '/v1/public/forms/{tenantId}/{formId}',
    operationId: 'getPublicWebForm',
    summary: 'An active form, as a page renders it',
    tags: ['forms'],
    auth: 'public',
    visibility: 'internal',
    request: {
      params: PublicFormParams,
      query: z.object({ locale: z.enum(['en', 'ar']).default('en') }).strict(),
    },
    responses: { 200: { description: 'The form', body: PublicWebFormDto } },
  }),
  submitPublicWebForm: defineRoute({
    method: 'post',
    path: '/v1/public/forms/{tenantId}/{formId}/submissions',
    operationId: 'submitPublicWebForm',
    summary: 'Submit a form (stored, then a lead through duplicate and assignment rules)',
    tags: ['forms'],
    auth: 'public',
    visibility: 'internal',
    request: { params: PublicFormParams, body: SubmitWebFormRequest },
    responses: {
      202: { description: 'Received', body: SubmitWebFormResponse },
      429: { description: 'Too many submissions from this network' },
    },
  }),
};
