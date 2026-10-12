import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { Uuid } from '../primitives.js';
import { setupCrud } from './setup.js';

/*
 * Email-to-lead (§7.1): per-tenant inbound addresses (Setup), the delivery endpoint the inbound
 * adapter calls (SES in cells, a shared secret locally), and the emails stored on a record.
 */

const DefaultValue = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);
const AddressStatus = z.enum(['ACTIVE', 'INACTIVE']);

export const InboundAddressDto = z
  .object({
    id: Uuid,
    name: z.string(),
    status: AddressStatus,
    /** Where to send or forward mail: `leads-{token}@{inbound domain}`. */
    address: z.string(),
    runAsUser: z.object({ id: Uuid, name: z.string() }),
    defaults: z.record(z.string(), DefaultValue),
    assignmentRuleId: Uuid.nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'InboundAddress' });

export const CreateInboundAddressRequest = z
  .object({
    name: z.string().trim().min(1).max(120),
    status: AddressStatus.default('ACTIVE'),
    /** The user leads are created as (an integration user with lead create). */
    runAsUserId: Uuid,
    /** Values for fields an email leaves empty (lead source, campaign, company). */
    defaults: z.record(z.string().max(80), DefaultValue).default({}),
    assignmentRuleId: Uuid.nullable().default(null),
  })
  .strict();

export const UpdateInboundAddressRequest = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    status: AddressStatus.optional(),
    runAsUserId: Uuid.optional(),
    defaults: z.record(z.string().max(80), DefaultValue).optional(),
    assignmentRuleId: Uuid.nullable().optional(),
    /** A new address; mail to the old one is no longer accepted. */
    rotateAddress: z.boolean().optional(),
    version: z.number().int().positive(),
  })
  .strict();

const EmailStatus = z.enum(['RECEIVED', 'CREATED', 'MATCHED', 'REJECTED', 'FAILED']);

export const InboundEmailDto = z
  .object({
    id: Uuid,
    receivedAt: z.iso.datetime(),
    status: EmailStatus,
    fromAddress: z.string(),
    fromName: z.string().nullable(),
    subject: z.string().nullable(),
    recordObject: z.string().nullable(),
    recordId: Uuid.nullable(),
    reason: z.string().nullable(),
  })
  .meta({ id: 'InboundEmail' });

export const InboundEmailDetailDto = InboundEmailDto.extend({
  /** The message as plain text (HTML converted), from the stored original. */
  text: z.string(),
}).meta({ id: 'InboundEmailDetail' });

const RecordParams = z.object({ object: z.enum(['lead', 'contact']), id: Uuid });

export const inboundEmailRoutes = {
  ...setupCrud(
    '/v1/setup/inbound-addresses',
    'setup',
    'inbound address',
    {
      list: 'listInboundAddresses',
      get: 'getInboundAddress',
      create: 'createInboundAddress',
      update: 'updateInboundAddress',
      remove: 'deleteInboundAddress',
    },
    {
      item: InboundAddressDto,
      detail: InboundAddressDto,
      create: CreateInboundAddressRequest,
      update: UpdateInboundAddressRequest,
    },
  ),
  listAddressEmails: defineRoute({
    method: 'get',
    path: '/v1/setup/inbound-addresses/{id}/emails',
    operationId: 'listInboundAddressEmails',
    summary: 'Emails received at an address, newest first',
    tags: ['setup'],
    auth: 'session',
    visibility: 'internal',
    request: {
      params: z.object({ id: Uuid }),
      query: z
        .object({
          status: EmailStatus.optional(),
          before: Uuid.optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .strict(),
    },
    responses: {
      200: {
        description: 'Emails',
        body: z.object({ items: z.array(InboundEmailDto), next: Uuid.nullable() }),
      },
      403: { description: 'The caller lacks view_setup' },
    },
  }),
  receiveInboundEmail: defineRoute({
    method: 'post',
    path: '/v1/inbound/email',
    operationId: 'receiveInboundEmail',
    summary: 'Deliver inbound mail (from the inbound adapter: SES via SNS, or the shared secret)',
    description:
      'Authenticated by the adapter itself (SNS signature, or `x-sm-inbound-secret`); 401 otherwise.',
    tags: ['inbound'],
    auth: 'public',
    visibility: 'internal',
    request: { body: z.unknown() },
    responses: {
      202: { description: 'Accepted', body: z.object({ accepted: z.number().int() }) },
      401: { description: 'Not from a configured inbound source' },
    },
  }),
  listRecordInboundEmails: defineRoute({
    method: 'get',
    path: '/v1/records/{object}/{id}/inbound-emails',
    operationId: 'listRecordInboundEmails',
    summary: 'Emails received from a lead or contact, newest first (up to 50)',
    tags: ['records'],
    auth: 'session',
    visibility: 'internal',
    request: { params: RecordParams },
    responses: {
      200: { description: 'Emails', body: z.object({ items: z.array(InboundEmailDto) }) },
    },
  }),
  getRecordInboundEmail: defineRoute({
    method: 'get',
    path: '/v1/records/{object}/{id}/inbound-emails/{emailId}',
    operationId: 'getRecordInboundEmail',
    summary: 'One email received from a lead or contact, with its text',
    tags: ['records'],
    auth: 'session',
    visibility: 'internal',
    request: { params: RecordParams.extend({ emailId: Uuid }) },
    responses: { 200: { description: 'The email', body: InboundEmailDetailDto } },
  }),
};
