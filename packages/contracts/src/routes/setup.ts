import { z } from 'zod';

import { defineRoute, type RouteContract } from '../openapi.js';
import { Uuid } from '../primitives.js';
import { ObjectApiName } from './access.js';

const NamedRef = z.object({ id: Uuid, name: z.string() });
const Name = z.string().trim().min(1).max(80);
const Description = z.string().trim().max(500).nullable().optional();
const Version = z.number().int().positive();
const FieldApiName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'Must be a field API name');

// ── Grants (profiles, permission sets, muting sets; §6.2) ─────────────────────────────────────
export const ObjectAccessDto = z
  .object({
    read: z.boolean(),
    create: z.boolean(),
    edit: z.boolean(),
    delete: z.boolean(),
    viewAll: z.boolean(),
    modifyAll: z.boolean(),
  })
  .strict()
  .meta({ id: 'ObjectAccess' });

export const GrantsDto = z
  .object({
    system: z.array(z.string().regex(/^[a-z]+(_[a-z]+)*$/)).max(100),
    objects: z.record(ObjectApiName, ObjectAccessDto),
    fields: z.record(
      ObjectApiName,
      z.record(FieldApiName, z.object({ read: z.boolean(), edit: z.boolean() }).strict()),
    ),
  })
  .strict()
  .meta({ id: 'Grants' });

export const ProfileSummary = z
  .object({
    id: Uuid,
    name: z.string(),
    description: z.string().nullable(),
    /** Built-in profiles cannot be deleted. */
    systemKey: z.string().nullable(),
    users: z.number().int(),
    version: z.number().int(),
  })
  .meta({ id: 'ProfileSummary' });
export const ProfileDetail = ProfileSummary.extend({ grants: GrantsDto }).meta({
  id: 'ProfileDetail',
});

export const PermissionSetSummary = z
  .object({
    id: Uuid,
    name: z.string(),
    description: z.string().nullable(),
    assignedUsers: z.number().int(),
    groups: z.number().int(),
    version: z.number().int(),
  })
  .meta({ id: 'PermissionSetSummary' });
export const PermissionSetDetail = PermissionSetSummary.extend({ grants: GrantsDto }).meta({
  id: 'PermissionSetDetail',
});

export const PermissionSetGroupDetail = z
  .object({
    id: Uuid,
    name: z.string(),
    description: z.string().nullable(),
    permissionSets: z.array(NamedRef),
    /** What the group's muting set removes from its own sets, or null. */
    muting: GrantsDto.nullable(),
    assignedUsers: z.number().int(),
    version: z.number().int(),
  })
  .meta({ id: 'PermissionSetGroupDetail' });

export const CreateProfileRequest = z
  .object({ name: Name, description: Description, cloneFrom: Uuid.optional() })
  .strict();
export const CreatePermissionSetRequest = z
  .object({ name: Name, description: Description, grants: GrantsDto.optional() })
  .strict();
export const UpdateNamedRequest = z
  .object({ version: Version, name: Name.optional(), description: Description })
  .strict();
export const PutGrantsRequest = z.object({ version: Version, grants: GrantsDto }).strict();
export const CreatePermissionSetGroupRequest = z
  .object({
    name: Name,
    description: Description,
    permissionSetIds: z.array(Uuid).max(100),
    muting: GrantsDto.nullable().optional(),
  })
  .strict();
export const UpdatePermissionSetGroupRequest = z
  .object({
    version: Version,
    name: Name.optional(),
    description: Description,
    permissionSetIds: z.array(Uuid).max(100).optional(),
    muting: GrantsDto.nullable().optional(),
  })
  .strict();

// ── Hierarchy, groups, queues (§6.3) ──────────────────────────────────────────────────────────
export const OrgUnitDto = z
  .object({
    id: Uuid,
    name: z.string(),
    description: z.string().nullable(),
    parentId: Uuid.nullable(),
    users: z.number().int(),
    version: z.number().int(),
  })
  .meta({ id: 'OrgUnit' });
export const CreateOrgUnitRequest = z
  .object({ name: Name, description: Description, parentId: Uuid.nullable().optional() })
  .strict();
export const UpdateOrgUnitRequest = z
  .object({
    version: Version,
    name: Name.optional(),
    description: Description,
    /** Moving a unit moves its whole subtree. */
    parentId: Uuid.nullable().optional(),
  })
  .strict();

export const MemberType = z.enum(['USER', 'GROUP', 'ORG_UNIT', 'ORG_UNIT_AND_SUBORDINATES']);
export const MemberDto = z
  .object({ type: MemberType, id: Uuid, name: z.string() })
  .meta({ id: 'Member' });
const MemberInput = z.object({ type: MemberType, id: Uuid }).strict();

export const PublicGroupDto = z
  .object({
    id: Uuid,
    name: z.string(),
    description: z.string().nullable(),
    members: z.array(MemberDto),
    /** Users the group contains, through nested groups and org units. */
    userCount: z.number().int(),
    version: z.number().int(),
  })
  .meta({ id: 'PublicGroup' });
export const CreateGroupRequest = z
  .object({ name: Name, description: Description, members: z.array(MemberInput).max(500) })
  .strict();
export const UpdateGroupRequest = z
  .object({
    version: Version,
    name: Name.optional(),
    description: Description,
    members: z.array(MemberInput).max(500).optional(),
  })
  .strict();

export const QueueDto = z
  .object({
    id: Uuid,
    name: z.string(),
    email: z.string().nullable(),
    description: z.string().nullable(),
    objects: z.array(ObjectApiName),
    members: z.array(MemberDto),
    userCount: z.number().int(),
    version: z.number().int(),
  })
  .meta({ id: 'Queue' });
export const CreateQueueRequest = z
  .object({
    name: Name,
    email: z.email().nullable().optional(),
    description: Description,
    objects: z.array(ObjectApiName).min(1).max(50),
    members: z.array(MemberInput).max(500),
  })
  .strict();
export const UpdateQueueRequest = z
  .object({
    version: Version,
    name: Name.optional(),
    email: z.email().nullable().optional(),
    description: Description,
    objects: z.array(ObjectApiName).min(1).max(50).optional(),
    members: z.array(MemberInput).max(500).optional(),
  })
  .strict();

// ── Sharing (§6.3, §6.4) ──────────────────────────────────────────────────────────────────────
export const SharingModelDto = z.enum([
  'PRIVATE',
  'PUBLIC_READ',
  'PUBLIC_READ_WRITE',
  'CONTROLLED_BY_PARENT',
]);
export const OrgWideDefaultDto = z
  .object({
    object: ObjectApiName,
    sharingModel: SharingModelDto,
    grantHierarchy: z.boolean(),
    allowedModels: z.array(SharingModelDto),
    /** Standard objects always grant access through the hierarchy. */
    hierarchyEditable: z.boolean(),
  })
  .meta({ id: 'OrgWideDefault' });
export const UpdateOrgWideDefaultRequest = z
  .object({ sharingModel: SharingModelDto, grantHierarchy: z.boolean().optional() })
  .strict();

const PrincipalType = z.enum(['USER', 'GROUP', 'QUEUE', 'ORG_UNIT', 'ORG_UNIT_AND_SUBORDINATES']);
const PrincipalRef = z.object({ type: PrincipalType, id: Uuid, name: z.string() });
const RuleAccess = z.enum(['read', 'edit']);

export const JobRunDto = z
  .object({
    id: Uuid,
    status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']),
    done: z.number().int(),
    total: z.number().int().nullable(),
    error: z.string().nullable(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .meta({ id: 'JobRun' });

export const SharingRuleDto = z
  .object({
    id: Uuid,
    object: ObjectApiName,
    name: z.string(),
    description: z.string().nullable(),
    kind: z.enum(['OWNER', 'CRITERIA']),
    /** OWNER rules: records owned by members of this group or org unit. */
    source: PrincipalRef.nullable(),
    /** CRITERIA rules: the filter tree records must match. */
    criteria: z.unknown().nullable(),
    target: PrincipalRef,
    access: RuleAccess,
    active: z.boolean(),
    version: z.number().int(),
    /** The latest recalculation of this rule's shares. */
    lastRun: JobRunDto.nullable(),
  })
  .meta({ id: 'SharingRule' });

const RuleSource = z
  .object({ type: z.enum(['GROUP', 'ORG_UNIT', 'ORG_UNIT_AND_SUBORDINATES']), id: Uuid })
  .strict();
const RuleTarget = RuleSource;
export const CreateSharingRuleRequest = z
  .object({
    object: ObjectApiName,
    name: Name,
    description: Description,
    kind: z.enum(['OWNER', 'CRITERIA']),
    source: RuleSource.optional(),
    criteria: z.unknown().optional(),
    target: RuleTarget,
    access: RuleAccess,
    active: z.boolean().default(true),
  })
  .strict();
export const UpdateSharingRuleRequest = z
  .object({
    version: Version,
    name: Name.optional(),
    description: Description,
    source: RuleSource.optional(),
    criteria: z.unknown().optional(),
    target: RuleTarget.optional(),
    access: RuleAccess.optional(),
    active: z.boolean().optional(),
  })
  .strict();

export const RecordShareDto = z
  .object({
    principal: PrincipalRef,
    access: z.enum(['read', 'edit', 'full']),
    reason: z.enum(['RULE', 'MANUAL', 'TEAM', 'TERRITORY', 'IMPLICIT_PARENT', 'IMPLICIT_CHILD']),
    sourceId: Uuid.nullable(),
  })
  .meta({ id: 'RecordShare' });
export const ManualShareRequest = z
  .object({
    principal: z
      .object({
        type: z.enum(['USER', 'GROUP', 'ORG_UNIT', 'ORG_UNIT_AND_SUBORDINATES']),
        id: Uuid,
      })
      .strict(),
    access: RuleAccess,
  })
  .strict();
export const RevokeShareQuery = z.object({
  principalType: z.enum(['USER', 'GROUP', 'ORG_UNIT', 'ORG_UNIT_AND_SUBORDINATES']),
  principalId: Uuid,
});

// ── Routes ────────────────────────────────────────────────────────────────────────────────────
/** `{id}` of a Setup entity. */
export const SetupIdParam = z.object({ id: Uuid });
const idParam = SetupIdParam;
const forbidden = { 403: { description: 'The caller lacks the required system permission' } };
const list = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });

interface CrudNames {
  list: string;
  get: string;
  create: string;
  update: string;
  remove: string;
}

function crud<const N extends CrudNames>(
  base: string,
  tag: string,
  noun: string,
  names: N,
  shapes: { item: z.ZodType; detail: z.ZodType; create: z.ZodType; update: z.ZodType },
): Record<N[keyof CrudNames], RouteContract> {
  const routes: Record<string, RouteContract> = {
    [names.list]: defineRoute({
      method: 'get',
      path: base,
      operationId: names.list,
      summary: `List ${noun}s`,
      tags: [tag],
      auth: 'session',
      visibility: 'internal',
      responses: { 200: { description: `${noun}s`, body: list(shapes.item) }, ...forbidden },
    }),
    [names.get]: defineRoute({
      method: 'get',
      path: `${base}/{id}`,
      operationId: names.get,
      summary: `A ${noun}`,
      tags: [tag],
      auth: 'session',
      visibility: 'internal',
      request: { params: idParam },
      responses: { 200: { description: `The ${noun}`, body: shapes.detail }, ...forbidden },
    }),
    [names.create]: defineRoute({
      method: 'post',
      path: base,
      operationId: names.create,
      summary: `Create a ${noun}`,
      tags: [tag],
      auth: 'session',
      visibility: 'internal',
      request: { body: shapes.create },
      responses: {
        201: { description: `The new ${noun}`, body: shapes.detail },
        409: { description: 'The name is taken' },
        ...forbidden,
      },
    }),
    [names.update]: defineRoute({
      method: 'patch',
      path: `${base}/{id}`,
      operationId: names.update,
      summary: `Change a ${noun}`,
      tags: [tag],
      auth: 'session',
      visibility: 'internal',
      request: { params: idParam, body: shapes.update },
      responses: {
        200: { description: `The ${noun}`, body: shapes.detail },
        409: { description: 'Stale version, a taken name, or a cycle' },
        ...forbidden,
      },
    }),
    [names.remove]: defineRoute({
      method: 'delete',
      path: `${base}/{id}`,
      operationId: names.remove,
      summary: `Delete a ${noun}`,
      tags: [tag],
      auth: 'session',
      visibility: 'internal',
      request: { params: idParam },
      responses: {
        204: { description: 'Deleted' },
        409: { description: 'Still in use' },
        ...forbidden,
      },
    }),
  };
  return routes;
}

const grantsRoute = (base: string, operationId: string, noun: string, detail: z.ZodType) =>
  defineRoute({
    method: 'put',
    path: `${base}/{id}/grants`,
    operationId,
    summary: `Replace a ${noun}'s system, object and field permissions`,
    tags: ['setup'],
    auth: 'session',
    visibility: 'internal',
    request: { params: idParam, body: PutGrantsRequest },
    responses: { 200: { description: `The ${noun}`, body: detail }, ...forbidden },
  });

/** Setup → hierarchy, permissions, groups, queues and sharing (§6.2–6.4). */
export const setupRoutes = {
  ...crud(
    '/v1/org-units',
    'setup',
    'org unit',
    {
      list: 'listOrgUnits',
      get: 'getOrgUnit',
      create: 'createOrgUnit',
      update: 'updateOrgUnit',
      remove: 'deleteOrgUnit',
    },
    {
      item: OrgUnitDto,
      detail: OrgUnitDto,
      create: CreateOrgUnitRequest,
      update: UpdateOrgUnitRequest,
    },
  ),
  ...crud(
    '/v1/profiles',
    'setup',
    'profile',
    {
      list: 'listProfiles',
      get: 'getProfile',
      create: 'createProfile',
      update: 'updateProfile',
      remove: 'deleteProfile',
    },
    {
      item: ProfileSummary,
      detail: ProfileDetail,
      create: CreateProfileRequest,
      update: UpdateNamedRequest,
    },
  ),
  putProfileGrants: grantsRoute('/v1/profiles', 'putProfileGrants', 'profile', ProfileDetail),
  ...crud(
    '/v1/permission-sets',
    'setup',
    'permission set',
    {
      list: 'listPermissionSets',
      get: 'getPermissionSet',
      create: 'createPermissionSet',
      update: 'updatePermissionSet',
      remove: 'deletePermissionSet',
    },
    {
      item: PermissionSetSummary,
      detail: PermissionSetDetail,
      create: CreatePermissionSetRequest,
      update: UpdateNamedRequest,
    },
  ),
  putPermissionSetGrants: grantsRoute(
    '/v1/permission-sets',
    'putPermissionSetGrants',
    'permission set',
    PermissionSetDetail,
  ),
  ...crud(
    '/v1/permission-set-groups',
    'setup',
    'permission set group',
    {
      list: 'listPermissionSetGroups',
      get: 'getPermissionSetGroup',
      create: 'createPermissionSetGroup',
      update: 'updatePermissionSetGroup',
      remove: 'deletePermissionSetGroup',
    },
    {
      item: PermissionSetGroupDetail,
      detail: PermissionSetGroupDetail,
      create: CreatePermissionSetGroupRequest,
      update: UpdatePermissionSetGroupRequest,
    },
  ),
  ...crud(
    '/v1/groups',
    'setup',
    'public group',
    {
      list: 'listGroups',
      get: 'getGroup',
      create: 'createGroup',
      update: 'updateGroup',
      remove: 'deleteGroup',
    },
    {
      item: PublicGroupDto,
      detail: PublicGroupDto,
      create: CreateGroupRequest,
      update: UpdateGroupRequest,
    },
  ),
  ...crud(
    '/v1/queues',
    'setup',
    'queue',
    {
      list: 'listQueues',
      get: 'getQueue',
      create: 'createQueue',
      update: 'updateQueue',
      remove: 'deleteQueue',
    },
    { item: QueueDto, detail: QueueDto, create: CreateQueueRequest, update: UpdateQueueRequest },
  ),
  listOrgWideDefaults: defineRoute({
    method: 'get',
    path: '/v1/sharing/owd',
    operationId: 'listOrgWideDefaults',
    summary: 'Org-wide defaults of every object, with the models each allows',
    tags: ['setup'],
    auth: 'session',
    visibility: 'internal',
    responses: {
      200: { description: 'Org-wide defaults', body: list(OrgWideDefaultDto) },
      ...forbidden,
    },
  }),
  updateOrgWideDefault: defineRoute({
    method: 'put',
    path: '/v1/sharing/owd/{object}',
    operationId: 'updateOrgWideDefault',
    summary: 'Change an object’s org-wide default',
    tags: ['setup'],
    auth: 'session',
    visibility: 'internal',
    request: { params: z.object({ object: ObjectApiName }), body: UpdateOrgWideDefaultRequest },
    responses: {
      200: { description: 'The org-wide default', body: OrgWideDefaultDto },
      ...forbidden,
    },
  }),
  ...crud(
    '/v1/sharing/rules',
    'setup',
    'sharing rule',
    {
      list: 'listSharingRules',
      get: 'getSharingRule',
      create: 'createSharingRule',
      update: 'updateSharingRule',
      remove: 'deleteSharingRule',
    },
    {
      item: SharingRuleDto,
      detail: SharingRuleDto,
      create: CreateSharingRuleRequest,
      update: UpdateSharingRuleRequest,
    },
  ),
  listRecordShares: defineRoute({
    method: 'get',
    path: '/v1/records/{object}/{id}/share',
    operationId: 'listRecordShares',
    summary: 'Who a record is shared with, and why (needs Full access to the record)',
    tags: ['records'],
    auth: 'session',
    visibility: 'internal',
    request: { params: z.object({ object: ObjectApiName, id: Uuid }) },
    responses: {
      200: { description: 'The record’s shares', body: list(RecordShareDto) },
      403: { description: 'The caller can see the record but has no Full access' },
      404: { description: 'No such record, or the caller cannot see it' },
    },
  }),
  shareRecord: defineRoute({
    method: 'post',
    path: '/v1/records/{object}/{id}/share',
    operationId: 'shareRecord',
    summary: 'Share a record manually with a user, group or role (Read or Read-Write)',
    tags: ['records'],
    auth: 'session',
    visibility: 'internal',
    request: { params: z.object({ object: ObjectApiName, id: Uuid }), body: ManualShareRequest },
    responses: {
      200: { description: 'The record’s shares', body: list(RecordShareDto) },
      403: { description: 'The caller can see the record but has no Full access' },
      404: { description: 'No such record, or the caller cannot see it' },
    },
  }),
  unshareRecord: defineRoute({
    method: 'delete',
    path: '/v1/records/{object}/{id}/share',
    operationId: 'unshareRecord',
    summary: 'Remove a manual share',
    tags: ['records'],
    auth: 'session',
    visibility: 'internal',
    request: { params: z.object({ object: ObjectApiName, id: Uuid }), query: RevokeShareQuery },
    responses: {
      204: { description: 'Removed' },
      403: { description: 'The caller can see the record but has no Full access' },
      404: { description: 'No such record, share, or visible record' },
    },
  }),
};
