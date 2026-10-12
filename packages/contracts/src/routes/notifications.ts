import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { Uuid } from '../primitives.js';

export const NotificationDto = z
  .object({
    id: Uuid,
    /** assignment, sla_warning, sla_breach, sla_escalation, … (the UI words each kind). */
    kind: z.string(),
    /** Message parameters: policy name, minutes, the method and reason of an assignment. */
    params: z.record(z.string(), z.unknown()),
    object: z.string().nullable(),
    recordId: Uuid.nullable(),
    createdAt: z.iso.datetime(),
    readAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Notification' });

export const NotificationsQuery = z
  .object({
    unread: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: z.string().max(100).optional(),
  })
  .strict();

export const MarkReadRequest = z
  .object({
    ids: z.array(Uuid).min(1).max(200).optional(),
    /** Everything up to now. */
    all: z.literal(true).optional(),
  })
  .strict()
  .refine((v) => (v.ids === undefined) !== (v.all === undefined), {
    message: 'Give either ids or all',
  });

/** The header bell (§7.18, minimal in P03): the caller's own notifications. */
export const notificationRoutes = {
  listNotifications: defineRoute({
    method: 'get',
    path: '/v1/notifications',
    operationId: 'listNotifications',
    summary: 'The caller’s notifications, latest first, with the unread count',
    tags: ['me'],
    auth: 'session',
    visibility: 'internal',
    request: { query: NotificationsQuery },
    responses: {
      200: {
        description: 'A page',
        body: z.object({
          items: z.array(NotificationDto),
          unreadCount: z.number().int(),
          nextCursor: z.string().nullable(),
        }),
      },
    },
  }),
  markNotificationsRead: defineRoute({
    method: 'post',
    path: '/v1/notifications/read',
    operationId: 'markNotificationsRead',
    summary: 'Mark some or all of the caller’s notifications read',
    tags: ['me'],
    auth: 'session',
    visibility: 'internal',
    request: { body: MarkReadRequest },
    responses: {
      200: {
        description: 'How many changed, and what is left unread',
        body: z.object({ updated: z.number().int(), unreadCount: z.number().int() }),
      },
    },
  }),
};
