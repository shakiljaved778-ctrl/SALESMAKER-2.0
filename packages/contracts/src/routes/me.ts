import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { MeResponse, NewPassword, TotpCode } from './auth.js';

const Optional = (max: number) => z.string().trim().max(max).nullable().optional();

export const UpdateMyProfileRequest = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    title: Optional(120),
    phone: Optional(40),
  })
  .strict()
  .meta({ id: 'UpdateMyProfileRequest' });

export const ChangePasswordRequest = z
  .object({ currentPassword: z.string().min(1).max(256), newPassword: NewPassword })
  .strict()
  .meta({ id: 'ChangePasswordRequest' });

/** Proof of the second factor for a sensitive change: a current TOTP code or a recovery code. */
export const MfaProofRequest = z
  .union([
    z.object({ code: TotpCode }).strict(),
    z.object({ recoveryCode: z.string().regex(/^[a-z2-7]{4}-[a-z2-7]{4}$/i) }).strict(),
  ])
  .meta({ id: 'MfaProofRequest' });

export const RecoveryCodesResponse = z
  .object({ recoveryCodes: z.array(z.string()).length(10) })
  .meta({ id: 'RecoveryCodesResponse' });

/** Personal settings (§9 personal settings; §6.1): the signed-in user changes their own account. */
export const meRoutes = {
  updateMyProfile: defineRoute({
    method: 'patch',
    path: '/v1/me/profile',
    operationId: 'updateMyProfile',
    summary: 'Change your own name, job title and phone',
    tags: ['me'],
    auth: 'session',
    visibility: 'internal',
    request: { body: UpdateMyProfileRequest },
    responses: { 200: { description: 'You, updated', body: MeResponse } },
  }),
  changeMyPassword: defineRoute({
    method: 'post',
    path: '/v1/me/password',
    operationId: 'changeMyPassword',
    summary: 'Change your password; every other session is signed out',
    tags: ['me'],
    auth: 'session',
    visibility: 'internal',
    request: { body: ChangePasswordRequest },
    responses: {
      204: { description: 'Changed' },
      400: { description: 'The current password is wrong, or the new one is breached' },
      409: { description: 'You sign in with Google or Microsoft and have no password' },
    },
  }),
  disableMyMfa: defineRoute({
    method: 'post',
    path: '/v1/me/mfa/disable',
    operationId: 'disableMyMfa',
    summary: 'Turn two-step verification off (needs a current code or a recovery code)',
    tags: ['me'],
    auth: 'session',
    visibility: 'internal',
    request: { body: MfaProofRequest },
    responses: {
      204: { description: 'Two-step verification is off' },
      400: { description: 'The code did not work' },
      409: { description: 'Two-step verification is not on' },
    },
  }),
  regenerateRecoveryCodes: defineRoute({
    method: 'post',
    path: '/v1/me/mfa/recovery-codes',
    operationId: 'regenerateRecoveryCodes',
    summary: 'Replace your recovery codes (the old ones stop working); shown once',
    tags: ['me'],
    auth: 'session',
    visibility: 'internal',
    request: { body: MfaProofRequest },
    responses: {
      200: { description: 'New recovery codes', body: RecoveryCodesResponse },
      400: { description: 'The code did not work' },
      409: { description: 'Two-step verification is not on' },
    },
  }),
};
