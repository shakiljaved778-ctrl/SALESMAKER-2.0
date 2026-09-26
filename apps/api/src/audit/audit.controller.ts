import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { AuditChainStatus, AuditLogQuery, SetupAuditQuery } from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext } from '@sm/db';
import { errors, ZodPipe } from '@sm/server-kit';
import type { z } from 'zod';

import {
  RequireSystemPermission,
  SystemPermissionGuard,
} from '../access/system-permission.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentTenant, TenantContextGuard } from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';

const payloadOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Governance viewers (§6.7): the audit log, its chain status, and the Setup audit trail. */
@Controller('v1')
@UseGuards(AuthGuard, TenantContextGuard, SystemPermissionGuard)
@RequireSystemPermission('view_setup')
export class AuditController {
  constructor(@Inject(PRISMA) private readonly prisma: CellPrisma) {}

  @Get('audit-log')
  auditLog(
    @CurrentTenant() ctx: TenantContext,
    @Query(new ZodPipe(AuditLogQuery)) q: z.infer<typeof AuditLogQuery>,
  ) {
    let before: bigint | undefined;
    if (q.cursor) {
      if (!/^\d{1,19}$/.test(q.cursor))
        throw errors.validation([{ field: 'cursor', code: 'invalid', message: 'Invalid cursor' }]);
      before = BigInt(q.cursor);
    }
    return withTenant(this.prisma, ctx, async (tx) => {
      const rows = await tx.prisma.auditLog.findMany({
        where: {
          ...(before ? { seq: { lt: before } } : {}),
          ...(q.object ? { object: q.object } : {}),
          ...(q.recordId ? { recordId: q.recordId } : {}),
          ...(q.actorId ? { actorId: q.actorId } : {}),
          ...(q.action ? { action: q.action } : {}),
        },
        orderBy: { seq: 'desc' },
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      return {
        items: page.map((r) => ({
          seq: r.seq.toString(),
          id: r.id,
          occurredAt: r.occurredAt.toISOString(),
          actorType: r.actorType,
          actorId: r.actorId,
          onBehalfOf: r.onBehalfOf,
          action: r.action,
          object: r.object,
          recordId: r.recordId,
          payload: payloadOf(r.payload),
          chained: r.hash !== null,
        })),
        nextCursor: rows.length > q.limit ? (page.at(-1)?.seq.toString() ?? null) : null,
      };
    });
  }

  @Get('audit-log/verification')
  verification(@CurrentTenant() ctx: TenantContext): Promise<z.infer<typeof AuditChainStatus>> {
    return withTenant(this.prisma, ctx, async (tx) => {
      const [last, head, unchained] = await Promise.all([
        tx.prisma.auditVerification.findFirst({ orderBy: { startedAt: 'desc' } }),
        tx.prisma.auditBatch.findFirst({ orderBy: { lastSeq: 'desc' }, select: { lastSeq: true } }),
        tx.prisma.auditLog.count({ where: { hash: null } }),
      ]);
      return {
        lastVerification: last
          ? {
              status: last.status,
              verifiedAt: last.finishedAt.toISOString(),
              throughSeq: last.throughSeq?.toString() ?? null,
              rows: last.rows,
              problem: last.problem,
            }
          : null,
        chainedThroughSeq: head?.lastSeq.toString() ?? null,
        unchained,
      };
    });
  }

  @Get('setup-audit')
  setupAudit(
    @CurrentTenant() ctx: TenantContext,
    @Query(new ZodPipe(SetupAuditQuery)) q: z.infer<typeof SetupAuditQuery>,
  ) {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (q.cursor && !UUID.test(q.cursor))
      throw errors.validation([{ field: 'cursor', code: 'invalid', message: 'Invalid cursor' }]);
    return withTenant(this.prisma, ctx, async (tx) => {
      const rows = await tx.prisma.setupAudit.findMany({
        where: {
          ...(q.cursor ? { id: { lt: q.cursor } } : {}),
          ...(q.entityType ? { entityType: q.entityType } : {}),
          ...(q.entityId ? { entityId: q.entityId } : {}),
        },
        // UUIDv7 ids sort by time.
        orderBy: { id: 'desc' },
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      return {
        items: page.map((r) => ({
          id: r.id,
          occurredAt: r.occurredAt.toISOString(),
          actorId: r.actorId,
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          entityName: r.entityName,
          before: r.before,
          after: r.after,
        })),
        nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null,
      };
    });
  }
}
