import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { cursorPage, PageQuery } from '../pagination.js';
import { Timestamp, Uuid } from '../primitives.js';
import { ObjectApiName } from './access.js';

export const AuditLogEntry = z
  .object({
    /** Per-tenant sequence number (decimal string: it is a bigint). */
    seq: z.string().regex(/^\d+$/),
    id: Uuid,
    occurredAt: Timestamp,
    actorType: z.enum(['user', 'system', 'agent', 'support']),
    actorId: Uuid.nullable(),
    onBehalfOf: Uuid.nullable(),
    action: z.string(),
    object: z.string().nullable(),
    recordId: Uuid.nullable(),
    payload: z.record(z.string(), z.unknown()),
    /** Whether the row is already in the hash chain (it is, seconds after it is written). */
    chained: z.boolean(),
  })
  .meta({ id: 'AuditLogEntry' });

export const AuditLogQuery = PageQuery.extend({
  object: ObjectApiName.optional(),
  recordId: Uuid.optional(),
  actorId: Uuid.optional(),
  action: z.string().max(100).optional(),
});

export const AuditChainStatus = z
  .object({
    /** The latest verifier run, or null before the first. */
    lastVerification: z
      .object({
        status: z.enum(['OK', 'BROKEN']),
        verifiedAt: Timestamp,
        throughSeq: z.string().nullable(),
        rows: z.number().int(),
        problem: z.string().nullable(),
      })
      .nullable(),
    /** The highest sequence number chained so far. */
    chainedThroughSeq: z.string().nullable(),
    /** Rows written but not yet chained. */
    unchained: z.number().int(),
  })
  .meta({ id: 'AuditChainStatus' });

export const SetupAuditEntry = z
  .object({
    id: Uuid,
    occurredAt: Timestamp,
    actorId: Uuid.nullable(),
    action: z.string(),
    entityType: z.string(),
    entityId: Uuid.nullable(),
    entityName: z.string().nullable(),
    before: z.unknown().nullable(),
    after: z.unknown().nullable(),
  })
  .meta({ id: 'SetupAuditEntry' });

export const SetupAuditQuery = PageQuery.extend({
  entityType: z.string().max(64).optional(),
  entityId: Uuid.optional(),
});

/** Governance viewers (§6.7). Setup-only: `view_setup` is required. */
export const auditRoutes = {
  listAuditLog: defineRoute({
    method: 'get',
    path: '/v1/audit-log',
    operationId: 'listAuditLog',
    summary: 'The hash-chained audit log, newest first',
    tags: ['setup'],
    auth: 'session',
    visibility: 'internal',
    request: { query: AuditLogQuery },
    responses: {
      200: { description: 'A page of audit entries', body: cursorPage(AuditLogEntry) },
      403: { description: 'The caller lacks view_setup' },
    },
  }),
  auditChainStatus: defineRoute({
    method: 'get',
    path: '/v1/audit-log/verification',
    operationId: 'getAuditChainStatus',
    summary: 'How far the audit chain is built and when it was last verified',
    tags: ['setup'],
    auth: 'session',
    visibility: 'internal',
    responses: {
      200: { description: 'Chain status', body: AuditChainStatus },
      403: { description: 'The caller lacks view_setup' },
    },
  }),
  listSetupAudit: defineRoute({
    method: 'get',
    path: '/v1/setup-audit',
    operationId: 'listSetupAudit',
    summary: 'The Setup audit trail (configuration changes with before and after), newest first',
    tags: ['setup'],
    auth: 'session',
    visibility: 'internal',
    request: { query: SetupAuditQuery },
    responses: {
      200: { description: 'A page of Setup changes', body: cursorPage(SetupAuditEntry) },
      403: { description: 'The caller lacks view_setup' },
    },
  }),
};
