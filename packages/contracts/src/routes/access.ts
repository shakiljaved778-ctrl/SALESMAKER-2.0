import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { Uuid } from '../primitives.js';

/** A CRM object API name (§5.1): `lead`, `account`, `project__c`. */
export const ObjectApiName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,40}$/, 'Must be an object API name')
  .meta({ id: 'ObjectApiName', example: 'opportunity' });

export const RecordAccessLevel = z
  .enum(['none', 'read', 'edit', 'full'])
  .meta({ id: 'RecordAccessLevel', description: 'Record access (§6.3): Full is owner-equivalent' });

export const AccessReason = z
  .object({
    kind: z.enum([
      'SYSTEM_PERMISSION',
      'OBJECT_PERMISSION',
      'ORG_WIDE_DEFAULT',
      'OWNER',
      'HIERARCHY',
      'QUEUE',
      'SHARE',
      'PARENT',
    ]),
    level: RecordAccessLevel,
    /** view_all_data / modify_all_data, or View All / Modify All on the object. */
    permission: z.string().optional(),
    /** The org-wide default (ORG_WIDE_DEFAULT). */
    sharingModel: z.string().optional(),
    /** The record owner a manager sees through the hierarchy, or the queue that owns it. */
    ownerId: Uuid.optional(),
    /** SHARE: why it exists and whom it names. */
    shareReason: z
      .enum(['RULE', 'MANUAL', 'TEAM', 'TERRITORY', 'IMPLICIT_PARENT', 'IMPLICIT_CHILD'])
      .optional(),
    principalType: z
      .enum(['USER', 'GROUP', 'QUEUE', 'ORG_UNIT', 'ORG_UNIT_AND_SUBORDINATES'])
      .optional(),
    principalId: Uuid.optional(),
    /** PARENT: the record whose access this one follows. */
    parentObject: ObjectApiName.optional(),
    parentId: Uuid.optional(),
  })
  .meta({ id: 'AccessReason' });

export const AccessExplanation = z
  .object({
    object: ObjectApiName,
    recordId: Uuid,
    access: RecordAccessLevel,
    objectPermissions: z.object({
      read: z.boolean(),
      create: z.boolean(),
      edit: z.boolean(),
      delete: z.boolean(),
      viewAll: z.boolean(),
      modifyAll: z.boolean(),
    }),
    reasons: z.array(AccessReason),
  })
  .meta({ id: 'AccessExplanation' });

export const accessRoutes = {
  explainRecordAccess: defineRoute({
    method: 'get',
    path: '/v1/me/access/{object}/{id}',
    operationId: 'explainMyRecordAccess',
    summary:
      '“Why can I see this?”: every reason the caller can access a record, and at what level',
    tags: ['me'],
    auth: 'session',
    visibility: 'internal',
    request: { params: z.object({ object: ObjectApiName, id: Uuid }) },
    responses: {
      200: { description: 'The caller’s access and its reasons', body: AccessExplanation },
      404: { description: 'No such record, or the caller cannot see it' },
    },
  }),
};
