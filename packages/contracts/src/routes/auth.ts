import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { Email, Timestamp, Uuid } from '../primitives.js';

/**
 * Cell auth API (§6.1). Internal (§10.2): called by the web BFF, which owns the cookies; the API
 * itself is cookie-less and speaks tokens in JSON. Pre-auth routes name their workspace with the
 * `x-sm-tenant-id` header, resolved by the BFF from the host via the control plane.
 */
export const TenantHeader = z.object({ 'x-sm-tenant-id': Uuid });

/** §6.1: at least 12 characters; breach checking happens server-side. Max bounds argon2 work. */
export const NewPassword = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(256)
  .meta({ id: 'NewPassword' });

export const MeResponse = z
  .object({
    id: Uuid,
    tenantId: Uuid,
    email: Email,
    name: z.string(),
    emailVerified: z.boolean(),
    locale: z.string().nullable(),
    timezone: z.string().nullable(),
    theme: z.enum(['light', 'dark', 'system']),
    density: z.enum(['comfortable', 'default', 'compact']),
    mfaEnabled: z.boolean(),
    workspace: z.object({ name: z.string(), slug: z.string() }),
  })
  .meta({ id: 'Me' });

export const SessionTokens = z
  .object({
    accessToken: z.string(),
    accessTokenExpiresAt: Timestamp,
    refreshToken: z.string(),
    refreshTokenExpiresAt: Timestamp,
  })
  .meta({ id: 'SessionTokens' });

export const LoginResponse = z
  .discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), tokens: SessionTokens, user: MeResponse }),
    z.object({ status: z.literal('mfa_required'), mfaToken: z.string(), expiresAt: Timestamp }),
  ])
  .meta({ id: 'LoginResponse' });

export const LoginRequest = z
  .object({ email: Email, password: z.string().min(1).max(256) })
  .meta({ id: 'LoginRequest' });
export const RefreshRequest = z
  .object({ refreshToken: z.string().min(20).max(200) })
  .meta({ id: 'RefreshRequest' });
export const TokenRequest = z
  .object({ token: z.string().min(20).max(200) })
  .meta({ id: 'TokenRequest' });
export const EmailRequest = z.object({ email: Email }).meta({ id: 'EmailRequest' });
export const ResetPasswordRequest = z
  .object({ token: z.string().min(20).max(200), newPassword: NewPassword })
  .meta({ id: 'ResetPasswordRequest' });
export const PreferencesPatch = z
  .object({
    theme: z.enum(['light', 'dark', 'system']).optional(),
    density: z.enum(['comfortable', 'default', 'compact']).optional(),
    locale: z.string().max(16).nullable().optional(),
    timezone: z.string().max(64).nullable().optional(),
  })
  .strict()
  .meta({ id: 'PreferencesPatch' });

const tenantScoped = { headers: TenantHeader };

export const authRoutes = {
  login: defineRoute({
    method: 'post',
    path: '/auth/login',
    operationId: 'login',
    summary: 'Sign in with email and password',
    tags: ['auth'],
    auth: 'public',
    visibility: 'internal',
    request: { ...tenantScoped, body: LoginRequest },
    responses: {
      200: { description: 'Signed in, or a second factor is required', body: LoginResponse },
      403: { description: 'Email not verified' },
      423: { description: 'Locked after too many failed attempts' },
    },
  }),
  refresh: defineRoute({
    method: 'post',
    path: '/auth/refresh',
    operationId: 'refreshSession',
    summary: 'Rotate the refresh token and issue a new access token',
    description:
      'Presenting an already-used refresh token revokes the whole session (reuse detection).',
    tags: ['auth'],
    auth: 'public',
    visibility: 'internal',
    request: { ...tenantScoped, body: RefreshRequest },
    responses: { 200: { description: 'New tokens', body: SessionTokens } },
  }),
  logout: defineRoute({
    method: 'post',
    path: '/auth/logout',
    operationId: 'logout',
    summary: 'End the session that owns this refresh token',
    tags: ['auth'],
    auth: 'public',
    visibility: 'internal',
    request: { ...tenantScoped, body: RefreshRequest },
    responses: { 204: { description: 'Signed out' } },
  }),
  verifyEmail: defineRoute({
    method: 'post',
    path: '/auth/verify-email',
    operationId: 'verifyEmail',
    summary: 'Confirm an email address with the emailed token',
    tags: ['auth'],
    auth: 'public',
    visibility: 'internal',
    request: { ...tenantScoped, body: TokenRequest },
    responses: { 200: { description: 'Verified', body: z.object({ verified: z.literal(true) }) } },
  }),
  resendVerification: defineRoute({
    method: 'post',
    path: '/auth/verify-email/resend',
    operationId: 'resendVerificationEmail',
    summary: 'Send the verification link again (always 202)',
    tags: ['auth'],
    auth: 'public',
    visibility: 'internal',
    request: { ...tenantScoped, body: EmailRequest },
    responses: { 202: { description: 'Accepted' } },
  }),
  forgotPassword: defineRoute({
    method: 'post',
    path: '/auth/password/forgot',
    operationId: 'forgotPassword',
    summary: 'Email a password-reset link if the account exists (always 202)',
    tags: ['auth'],
    auth: 'public',
    visibility: 'internal',
    request: { ...tenantScoped, body: EmailRequest },
    responses: { 202: { description: 'Accepted' } },
  }),
  resetPassword: defineRoute({
    method: 'post',
    path: '/auth/password/reset',
    operationId: 'resetPassword',
    summary: 'Set a new password with a reset token; signs out every session',
    tags: ['auth'],
    auth: 'public',
    visibility: 'internal',
    request: { ...tenantScoped, body: ResetPasswordRequest },
    responses: { 204: { description: 'Password updated' } },
  }),
  me: defineRoute({
    method: 'get',
    path: '/v1/me',
    operationId: 'getMe',
    summary: 'The signed-in user and their display preferences',
    tags: ['me'],
    auth: 'session',
    visibility: 'internal',
    responses: { 200: { description: 'Current user', body: MeResponse } },
  }),
  updatePreferences: defineRoute({
    method: 'patch',
    path: '/v1/me/preferences',
    operationId: 'updateMyPreferences',
    summary: 'Update theme, density, locale or time zone',
    tags: ['me'],
    auth: 'session',
    visibility: 'internal',
    request: { body: PreferencesPatch },
    responses: { 200: { description: 'Updated user', body: MeResponse } },
  }),
};
