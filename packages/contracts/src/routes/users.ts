import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { cursorPage, PageQuery } from '../pagination.js';
import { Email, Timestamp, Uuid } from '../primitives.js';
import { LoginResponse, NewPassword, TenantHeader } from './auth.js';

const NamedRef = z.object({ id: Uuid, name: z.string() });

export const UserSummary = z
  .object({
    id: Uuid,
    email: Email,
    name: z.string(),
    /** PENDING until an invitation is accepted. */
    status: z.enum(['PENDING', 'ACTIVE', 'DISABLED']),
    deactivated: z.boolean(),
    title: z.string().nullable(),
    department: z.string().nullable(),
    phone: z.string().nullable(),
    profile: NamedRef.nullable(),
    orgUnit: NamedRef.nullable(),
    manager: NamedRef.nullable(),
    createdAt: Timestamp,
    /** Optimistic lock: send it back with a change. */
    version: z.number().int(),
  })
  .meta({ id: 'UserSummary' });

export const UserDetail = UserSummary.extend({
  permissionSets: z.array(NamedRef),
  permissionSetGroups: z.array(NamedRef),
  invitation: z
    .object({ id: Uuid, sentAt: Timestamp, expiresAt: Timestamp, expired: z.boolean() })
    .nullable(),
}).meta({ id: 'UserDetail' });

export const UserListQuery = PageQuery.extend({
  /** Matches name or email. */
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['PENDING', 'ACTIVE', 'DISABLED', 'DEACTIVATED']).optional(),
  profileId: Uuid.optional(),
  orgUnitId: Uuid.optional(),
});

const PersonName = z.string().trim().min(1).max(120);
const Optional = (max: number) => z.string().trim().max(max).nullable().optional();

export const InviteUserRequest = z
  .object({
    email: Email,
    name: PersonName,
    profileId: Uuid,
    orgUnitId: Uuid.nullable().optional(),
    managerId: Uuid.nullable().optional(),
    title: Optional(120),
    locale: z.string().max(16).nullable().optional(),
  })
  .strict()
  .meta({ id: 'InviteUserRequest' });

export const UpdateUserRequest = z
  .object({
    version: z.number().int().positive(),
    name: PersonName.optional(),
    profileId: Uuid.optional(),
    orgUnitId: Uuid.nullable().optional(),
    managerId: Uuid.nullable().optional(),
    title: Optional(120),
    department: Optional(120),
    phone: Optional(40),
  })
  .strict()
  .meta({ id: 'UpdateUserRequest' });

export const UserAssignmentsRequest = z
  .object({
    permissionSetIds: z.array(Uuid).max(100),
    permissionSetGroupIds: z.array(Uuid).max(100),
  })
  .strict()
  .meta({ id: 'UserAssignmentsRequest' });

export const AcceptInvitationRequest = z
  .object({
    token: z.string().min(20).max(200),
    name: PersonName.optional(),
    password: NewPassword,
  })
  .strict()
  .meta({ id: 'AcceptInvitationRequest' });

const userId = z.object({ id: Uuid });

/** Users and invitations (§6.1, §7 Setup → Users). Reading needs view_setup; changes manage_users. */
export const userRoutes = {
  listUsers: defineRoute({
    method: 'get',
    path: '/v1/users',
    operationId: 'listUsers',
    summary: 'Search the workspace’s users, by name',
    tags: ['setup'],
    auth: 'session',
    visibility: 'internal',
    request: { query: UserListQuery },
    responses: {
      200: { description: 'A page of users', body: cursorPage(UserSummary) },
      403: { description: 'The caller lacks view_setup' },
    },
  }),
  getUser: defineRoute({
    method: 'get',
    path: '/v1/users/{id}',
    operationId: 'getUser',
    summary: 'A user with their access: profile, placement, permission sets and groups',
    tags: ['setup'],
    auth: 'session',
    visibility: 'internal',
    request: { params: userId },
    responses: {
      200: { description: 'The user', body: UserDetail },
      403: { description: 'The caller lacks view_setup' },
    },
  }),
  updateUser: defineRoute({
    method: 'patch',
    path: '/v1/users/{id}',
    operationId: 'updateUser',
    summary: 'Change a user’s details, profile, org unit or manager',
    tags: ['setup'],
    auth: 'session',
    visibility: 'internal',
    request: { params: userId, body: UpdateUserRequest },
    responses: {
      200: { description: 'The updated user', body: UserDetail },
      403: { description: 'The caller lacks manage_users' },
      409: { description: 'Stale version, or a manager cycle' },
    },
  }),
  setUserAssignments: defineRoute({
    method: 'put',
    path: '/v1/users/{id}/assignments',
    operationId: 'setUserAssignments',
    summary: 'Replace the permission sets and permission set groups assigned to a user',
    tags: ['setup'],
    auth: 'session',
    visibility: 'internal',
    request: { params: userId, body: UserAssignmentsRequest },
    responses: {
      200: { description: 'The user', body: UserDetail },
      403: { description: 'The caller lacks manage_users' },
    },
  }),
  deactivateUser: defineRoute({
    method: 'post',
    path: '/v1/users/{id}/deactivate',
    operationId: 'deactivateUser',
    summary: 'Deactivate a user: they cannot sign in, and every session ends now',
    tags: ['setup'],
    auth: 'session',
    visibility: 'internal',
    request: { params: userId },
    responses: {
      200: { description: 'The user', body: UserDetail },
      403: { description: 'The caller lacks manage_users' },
      409: { description: 'The owner and the caller cannot be deactivated' },
    },
  }),
  reactivateUser: defineRoute({
    method: 'post',
    path: '/v1/users/{id}/reactivate',
    operationId: 'reactivateUser',
    summary: 'Reactivate a deactivated user',
    tags: ['setup'],
    auth: 'session',
    visibility: 'internal',
    request: { params: userId },
    responses: {
      200: { description: 'The user', body: UserDetail },
      403: { description: 'The caller lacks manage_users' },
    },
  }),
  inviteUser: defineRoute({
    method: 'post',
    path: '/v1/invitations',
    operationId: 'inviteUser',
    summary: 'Invite a person: creates a pending user and emails a 7-day invitation',
    tags: ['setup'],
    auth: 'session',
    visibility: 'internal',
    request: { body: InviteUserRequest },
    responses: {
      201: { description: 'The invited user', body: UserDetail },
      403: { description: 'The caller lacks manage_users' },
      409: { description: 'That email already belongs to a user of this workspace' },
    },
  }),
  resendInvitation: defineRoute({
    method: 'post',
    path: '/v1/invitations/{id}/resend',
    operationId: 'resendInvitation',
    summary: 'Send a fresh invitation (the previous link stops working)',
    tags: ['setup'],
    auth: 'session',
    visibility: 'internal',
    request: { params: userId },
    responses: {
      200: { description: 'The user', body: UserDetail },
      403: { description: 'The caller lacks manage_users' },
    },
  }),
  revokeInvitation: defineRoute({
    method: 'delete',
    path: '/v1/invitations/{id}',
    operationId: 'revokeInvitation',
    summary: 'Withdraw an invitation that has not been accepted; the pending user is removed',
    tags: ['setup'],
    auth: 'session',
    visibility: 'internal',
    request: { params: userId },
    responses: {
      204: { description: 'Withdrawn' },
      403: { description: 'The caller lacks manage_users' },
    },
  }),
  acceptInvitation: defineRoute({
    method: 'post',
    path: '/auth/invitations/accept',
    operationId: 'acceptInvitation',
    summary: 'Accept an invitation by choosing a password; signs the new user in',
    tags: ['auth'],
    auth: 'public',
    visibility: 'internal',
    request: { headers: TenantHeader, body: AcceptInvitationRequest },
    responses: {
      200: { description: 'Signed in, or a second factor is required', body: LoginResponse },
      400: { description: 'The link has expired, was withdrawn or was already used' },
    },
  }),
};
