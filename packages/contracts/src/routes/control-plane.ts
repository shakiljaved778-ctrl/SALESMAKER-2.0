import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { Email, TenantSlug, Uuid } from '../primitives.js';

/** Base64url-encoded 32-byte HMAC of a normalised email (spec v1.2): never the address itself. */
export const EmailHmac = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'Must be a base64url SHA-256 HMAC')
  .meta({ id: 'EmailHmac' });

export const TenantStatus = z.enum(['PENDING', 'ACTIVE', 'SUSPENDED']).meta({ id: 'TenantStatus' });

export const CellSummary = z
  .object({
    id: z.string(),
    region: z.string(),
    label: z.string(),
    apiBaseUrl: z.url(),
    signupOpen: z.boolean(),
  })
  .meta({ id: 'CellSummary' });

export const ResolvedTenant = z
  .object({
    tenantId: Uuid,
    slug: TenantSlug,
    name: z.string(),
    status: TenantStatus,
    cell: z.object({ id: z.string(), apiBaseUrl: z.url() }),
  })
  .meta({ id: 'ResolvedTenant' });

export const ReserveTenantRequest = z
  .object({
    slug: TenantSlug,
    name: z.string().trim().min(1).max(120),
    ownerEmailHmac: EmailHmac,
  })
  .meta({ id: 'ReserveTenantRequest' });

export const ReservedTenant = z
  .object({ tenantId: Uuid, slug: TenantSlug, status: TenantStatus, cellId: z.string() })
  .meta({ id: 'ReservedTenant' });

export const IdempotencyHeaders = z.object({
  'idempotency-key': z
    .string()
    .min(8)
    .max(128)
    .describe('Required: retries with the same key replay the first response'),
});

export const FindWorkspacesRequest = z
  .object({ email: Email, locale: z.string().max(16).optional() })
  .meta({ id: 'FindWorkspacesRequest' });

const tenantIdParams = z.object({ tenantId: Uuid });

/** Control-plane API (§3.4): tenant directory, login routing and signup reservations. */
export const controlPlaneRoutes = {
  listCells: defineRoute({
    method: 'get',
    path: '/cp/v1/cells',
    operationId: 'listCells',
    summary: 'Data regions a new organisation can choose',
    tags: ['tenants'],
    auth: 'public',
    visibility: 'internal',
    responses: { 200: { description: 'Cells', body: z.object({ cells: z.array(CellSummary) }) } },
  }),
  resolveTenant: defineRoute({
    method: 'get',
    path: '/cp/v1/tenants/resolve',
    operationId: 'resolveTenant',
    summary: 'Resolve a workspace host name to its tenant and cell',
    tags: ['tenants'],
    auth: 'public',
    visibility: 'internal',
    request: { query: z.object({ host: z.string().min(3).max(253) }) },
    responses: { 200: { description: 'The tenant and its cell', body: ResolvedTenant } },
  }),
  reserveTenant: defineRoute({
    method: 'post',
    path: '/cp/v1/tenants/reserve',
    operationId: 'reserveTenant',
    summary: 'Reserve a slug for a new tenant in the calling cell (signup step 1)',
    tags: ['tenants'],
    auth: 'service',
    visibility: 'internal',
    request: { headers: IdempotencyHeaders, body: ReserveTenantRequest },
    responses: {
      201: { description: 'Reserved (PENDING)', body: ReservedTenant },
      409: { description: 'The slug is taken' },
    },
  }),
  activateTenant: defineRoute({
    method: 'post',
    path: '/cp/v1/tenants/{tenantId}/activate',
    operationId: 'activateTenant',
    summary: 'Activate a reserved tenant once its owner verified their email (idempotent)',
    tags: ['tenants'],
    auth: 'service',
    visibility: 'internal',
    request: { params: tenantIdParams },
    responses: { 200: { description: 'Active', body: ReservedTenant } },
  }),
  releaseTenant: defineRoute({
    method: 'delete',
    path: '/cp/v1/tenants/{tenantId}/reservation',
    operationId: 'releaseTenantReservation',
    summary: 'Release a PENDING reservation (signup compensation)',
    tags: ['tenants'],
    auth: 'service',
    visibility: 'internal',
    request: { params: tenantIdParams },
    responses: { 204: { description: 'Released' } },
  }),
  findWorkspaces: defineRoute({
    method: 'post',
    path: '/cp/v1/workspaces/find',
    operationId: 'findWorkspaces',
    summary: 'Email the caller the workspaces their address belongs to (always 202)',
    tags: ['tenants'],
    auth: 'public',
    visibility: 'internal',
    request: { body: FindWorkspacesRequest },
    responses: { 202: { description: 'Accepted; an email is sent if any workspace matches' } },
  }),
};
