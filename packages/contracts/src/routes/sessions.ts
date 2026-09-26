import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { cursorPage, PageQuery } from '../pagination.js';
import { Timestamp, Uuid } from '../primitives.js';

export const SessionSummary = z
  .object({
    id: Uuid,
    createdAt: Timestamp,
    lastSeenAt: Timestamp,
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    mfaVerified: z.boolean(),
    /** The session this request is made from. */
    current: z.boolean(),
  })
  .meta({ id: 'SessionSummary' });

export const LoginHistoryEntry = z
  .object({
    id: Uuid,
    occurredAt: Timestamp,
    userId: Uuid.nullable(),
    method: z.enum(['password', 'google', 'microsoft', 'otp', 'recovery_code']),
    outcome: z.enum([
      'SUCCESS',
      'MFA_REQUIRED',
      'INVALID_CREDENTIALS',
      'INVALID_CODE',
      'LOCKED',
      'EMAIL_NOT_VERIFIED',
      'NO_ACCOUNT',
    ]),
    sessionId: Uuid.nullable(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
  })
  .meta({ id: 'LoginHistoryEntry' });

export const LoginHistoryQuery = PageQuery.extend({
  userId: Uuid.optional(),
  outcome: LoginHistoryEntry.shape.outcome.optional(),
});

/** The caller's sessions and sign-ins (§6.1), and the workspace login history (§6.7). */
export const sessionRoutes = {
  listMySessions: defineRoute({
    method: 'get',
    path: '/v1/me/sessions',
    operationId: 'listMySessions',
    summary: 'The caller’s signed-in sessions (devices), newest first',
    tags: ['me'],
    auth: 'session',
    visibility: 'internal',
    responses: {
      200: { description: 'Live sessions', body: z.object({ items: z.array(SessionSummary) }) },
    },
  }),
  revokeMySession: defineRoute({
    method: 'delete',
    path: '/v1/me/sessions/{id}',
    operationId: 'revokeMySession',
    summary: 'Sign out one of the caller’s sessions, wherever it is',
    tags: ['me'],
    auth: 'session',
    visibility: 'internal',
    request: { params: z.object({ id: Uuid }) },
    responses: {
      204: { description: 'Signed out' },
      404: { description: 'No such live session of the caller' },
    },
  }),
  revokeMyOtherSessions: defineRoute({
    method: 'post',
    path: '/v1/me/sessions/revoke-others',
    operationId: 'revokeMyOtherSessions',
    summary: 'Sign out everywhere else: every session of the caller except this one',
    tags: ['me'],
    auth: 'session',
    visibility: 'internal',
    responses: {
      200: {
        description: 'How many sessions were signed out',
        body: z.object({ revoked: z.number().int() }),
      },
    },
  }),
  listMyLoginHistory: defineRoute({
    method: 'get',
    path: '/v1/me/login-history',
    operationId: 'listMyLoginHistory',
    summary: 'The caller’s own sign-in attempts, newest first',
    tags: ['me'],
    auth: 'session',
    visibility: 'internal',
    request: { query: PageQuery },
    responses: { 200: { description: 'A page of attempts', body: cursorPage(LoginHistoryEntry) } },
  }),
  listLoginHistory: defineRoute({
    method: 'get',
    path: '/v1/login-history',
    operationId: 'listLoginHistory',
    summary: 'Every sign-in attempt in the workspace, newest first (Setup)',
    tags: ['setup'],
    auth: 'session',
    visibility: 'internal',
    request: { query: LoginHistoryQuery },
    responses: {
      200: { description: 'A page of attempts', body: cursorPage(LoginHistoryEntry) },
      403: { description: 'The caller lacks view_setup' },
    },
  }),
};
