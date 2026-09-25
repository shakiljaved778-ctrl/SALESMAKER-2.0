import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { CurrencyCode, Email, TenantSlug, Uuid } from '../primitives.js';
import { IdempotencyHeaders } from './control-plane.js';
import { LoginResponse, NewPassword, OidcCallbackRequest, OidcProviderParam } from './auth.js';

/** Organisation details collected at signup (§7.20a). Region is implied by the cell called. */
export const OrganisationInput = z.object({
  orgName: z.string().trim().min(2).max(120),
  slug: TenantSlug,
  currency: CurrencyCode,
  timezone: z.string().min(1).max(64),
  locale: z.string().max(16).optional(),
});

export const SignupRequest = OrganisationInput.extend({
  name: z.string().trim().min(1).max(120),
  email: Email,
  password: NewPassword,
}).meta({ id: 'SignupRequest' });

export const SignupResponse = z
  .object({
    tenantId: Uuid,
    slug: TenantSlug,
    status: z.literal('PENDING'),
    verificationSentTo: Email,
  })
  .meta({ id: 'SignupResponse' });

export const OidcSignupRequest = OidcCallbackRequest.extend(OrganisationInput.shape).meta({
  id: 'OidcSignupRequest',
});

export const OidcSignupResponse = z
  .object({ tenantId: Uuid, slug: TenantSlug, login: LoginResponse })
  .meta({ id: 'OidcSignupResponse' });

export const signupRoutes = {
  signup: defineRoute({
    method: 'post',
    path: '/auth/signup',
    operationId: 'signup',
    summary: 'Create an organisation and its owner in this cell; the owner verifies by email',
    description:
      'Reserves the slug with the control plane, provisions the workspace and owner in one tenant transaction (releasing the reservation if that fails), and emails a verification link. Retries with the same Idempotency-Key replay the first result.',
    tags: ['signup'],
    auth: 'public',
    visibility: 'internal',
    request: { headers: IdempotencyHeaders, body: SignupRequest },
    responses: {
      201: {
        description: 'Organisation created (pending email verification)',
        body: SignupResponse,
      },
      409: { description: 'The workspace address is taken' },
    },
  }),
  oidcSignup: defineRoute({
    method: 'post',
    path: '/auth/signup/oidc/{provider}',
    operationId: 'signupWithOidc',
    summary:
      'Create an organisation with a Google or Microsoft identity (already verified) and sign in',
    tags: ['signup'],
    auth: 'public',
    visibility: 'internal',
    request: { params: OidcProviderParam, headers: IdempotencyHeaders, body: OidcSignupRequest },
    responses: {
      201: { description: 'Organisation created and active; signed in', body: OidcSignupResponse },
      409: { description: 'The workspace address is taken' },
    },
  }),
};
