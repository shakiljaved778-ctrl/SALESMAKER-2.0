import { Body, Controller, Get, HttpCode, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { MarkReadRequest, NotificationsQuery, type NotificationDto } from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext, type TenantTransaction } from '@sm/db';
import { errors, ZodPipe } from '@sm/server-kit';
import { z } from 'zod';

import { CurrentTenant, TenantContextGuard } from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';
import { AuthGuard } from './auth.guard.js';

type Notification = z.infer<typeof NotificationDto>;

/**
 * The caller's in-app notifications (§7.18, minimal in P03): assignment and SLA events. A user
 * only ever sees their own; new ones also go out as `automation.notification_created`, the cue
 * for the realtime gateway to refresh the bell.
 */
@Controller('v1/notifications')
@UseGuards(AuthGuard, TenantContextGuard)
export class NotificationsController {
  constructor(@Inject(PRISMA) private readonly prisma: CellPrisma) {}

  private unread(tx: TenantTransaction, userId: string) {
    return tx.prisma.notification.count({ where: { userId, readAt: null } });
  }

  @Get()
  list(
    @CurrentTenant() t: TenantContext,
    @Query(new ZodPipe(NotificationsQuery)) q: z.output<typeof NotificationsQuery>,
  ): Promise<{ items: Notification[]; unreadCount: number; nextCursor: string | null }> {
    return withTenant(this.prisma, t, async (tx) => {
      const userId = t.userId ?? '';
      const [at, id] = q.cursor?.split('|') ?? [];
      const before = at ? new Date(at) : null;
      if (
        q.cursor &&
        (!before || Number.isNaN(before.getTime()) || !z.uuid().safeParse(id).success)
      )
        throw errors.validation([{ field: 'cursor', code: 'invalid', message: 'Invalid cursor' }]);
      const rows = await tx.prisma.notification.findMany({
        where: {
          userId,
          ...(q.unread === 'true' ? { readAt: null } : {}),
          ...(before && id
            ? { OR: [{ createdAt: { lt: before } }, { createdAt: before, id: { lt: id } }] }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        items: page.map((n) => ({
          id: n.id,
          kind: n.kind,
          params: (n.params ?? {}) as Record<string, unknown>,
          object: n.object,
          recordId: n.recordId,
          createdAt: n.createdAt.toISOString(),
          readAt: n.readAt?.toISOString() ?? null,
        })),
        unreadCount: await this.unread(tx, userId),
        nextCursor:
          rows.length > q.limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
      };
    });
  }

  @Post('read')
  @HttpCode(200)
  markRead(
    @CurrentTenant() t: TenantContext,
    @Body(new ZodPipe(MarkReadRequest)) body: z.output<typeof MarkReadRequest>,
  ) {
    return withTenant(this.prisma, t, async (tx) => {
      const userId = t.userId ?? '';
      const { count } = await tx.prisma.notification.updateMany({
        where: { userId, readAt: null, ...(body.ids ? { id: { in: body.ids } } : {}) },
        data: { readAt: new Date() },
      });
      return { updated: count, unreadCount: await this.unread(tx, userId) };
    });
  }
}
