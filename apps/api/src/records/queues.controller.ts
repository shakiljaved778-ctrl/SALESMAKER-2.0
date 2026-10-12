import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { queueRoutes, TakeNextRequest, type MyQueueDto } from '@sm/contracts';
import {
  membership,
  withTenant,
  type CellPrisma,
  type TenantContext,
  type TenantTransaction,
} from '@sm/db';
import { objectAccess } from '@sm/permissions';
import {
  assignmentEnv,
  hasAccess,
  RecordError,
  takeFromQueue,
  type RecordContext,
} from '@sm/records';
import { ZodPipe } from '@sm/server-kit';
import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { z } from 'zod';

import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentTenant, TenantContextGuard } from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';
import { RecordContextService } from './record-context.service.js';
import { translating } from './record-errors.js';

const QueueParam = queueRoutes.takeNext.request.params;
const RecordParam = queueRoutes.acceptRecord.request.params;
const QUEUE_OBJECTS = new Set(['lead', 'contact', 'account', 'opportunity']);

/** Queue pick-up (§7.3): members Accept a record or Take next, atomically. Audited. */
@Controller('v1')
@UseGuards(AuthGuard, TenantContextGuard)
export class QueuesController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly contexts: RecordContextService,
  ) {}

  private run<T>(
    t: TenantContext,
    request: FastifyRequest,
    fn: (tx: TenantTransaction, ctx: RecordContext) => Promise<T>,
  ) {
    return withTenant(this.prisma, t, async (tx) =>
      translating(async () => fn(tx, await this.contexts.forCaller(tx, request.id))),
    );
  }

  @Get('queues/mine')
  mine(
    @CurrentTenant() t: TenantContext,
    @Req() request: FastifyRequest,
  ): Promise<{ items: z.infer<typeof MyQueueDto>[] }> {
    return this.run(t, request, async (tx, ctx) => {
      const ids = await membership.userQueues(tx, ctx.userId);
      const queues = await tx.prisma.queue.findMany({
        where: { id: { in: ids }, deletedAt: null },
        include: { objects: true },
        orderBy: { name: 'asc' },
      });
      const items = [];
      for (const q of queues) {
        const objects = q.objects.map((o) => o.object).filter((o) => QUEUE_OBJECTS.has(o));
        const waiting: Record<string, number> = {};
        for (const o of objects) {
          const meta = ctx.metadata.object(o);
          if (!meta || !objectAccess(ctx.permissions, o).read) continue;
          const n = await sql<{
            n: string;
          }>`SELECT count(*)::text AS n FROM ${sql.table(meta.table)}
            WHERE tenant_id = ${tx.context.tenantId}::uuid AND owner_id = ${q.id}::uuid AND deleted_at IS NULL`.execute(
            tx.kysely,
          );
          waiting[o] = Number(n.rows[0]?.n ?? 0);
        }
        items.push({ id: q.id, name: q.name, objects, waiting });
      }
      return { items };
    });
  }

  private async take(
    tx: TenantTransaction,
    ctx: RecordContext,
    object: string,
    queueId: string,
    recordId: string | undefined,
  ) {
    const access = objectAccess(ctx.permissions, object);
    if (!ctx.metadata.object(object) || !access.read) throw new RecordError('not_found');
    if (!access.edit) throw new RecordError('forbidden');
    const queue = await tx.prisma.queue.findFirst({
      where: { id: queueId, deletedAt: null, objects: { some: { object } } },
    });
    if (!queue) throw new RecordError('not_found');
    if (!(await membership.userQueues(tx, ctx.userId)).includes(queueId))
      throw new RecordError('forbidden', [{ field: '_record', code: 'not_a_queue_member' }]);
    const id = await takeFromQueue(
      tx,
      { ...assignmentEnv(ctx), actorId: ctx.userId },
      object,
      queueId,
      {
        ...(recordId ? { recordId } : {}),
        source: recordId ? 'accept' : 'take_next',
      },
    );
    return { id, object: object as 'lead' };
  }

  @Post('queues/:id/take-next')
  @HttpCode(200)
  takeNext(
    @CurrentTenant() t: TenantContext,
    @Req() request: FastifyRequest,
    @Param(new ZodPipe(QueueParam)) p: z.infer<typeof QueueParam>,
    @Body(new ZodPipe(TakeNextRequest)) body: z.infer<typeof TakeNextRequest>,
  ) {
    return this.run(t, request, (tx, ctx) => this.take(tx, ctx, body.object, p.id, undefined));
  }

  @Post('records/:object/:id/accept')
  @HttpCode(200)
  accept(
    @CurrentTenant() t: TenantContext,
    @Req() request: FastifyRequest,
    @Param(new ZodPipe(RecordParam)) p: z.infer<typeof RecordParam>,
  ) {
    return this.run(t, request, async (tx, ctx) => {
      const object = ctx.metadata.object(p.object);
      if (!object || !(await hasAccess(tx, ctx, object, p.id, 'read')))
        throw new RecordError('not_found');
      const owner = await sql<{
        owner_id: string | null;
      }>`SELECT owner_id FROM ${sql.table(object.table)}
        WHERE tenant_id = ${tx.context.tenantId}::uuid AND id = ${p.id}::uuid`.execute(tx.kysely);
      const ownerId = owner.rows[0]?.owner_id ?? null;
      const queue = ownerId ? await tx.prisma.queue.findFirst({ where: { id: ownerId } }) : null;
      if (!queue) throw new RecordError('conflict', [{ field: '_record', code: 'not_in_a_queue' }]);
      const taken = await this.take(tx, ctx, p.object, queue.id, p.id);
      // Another member took it between the read and the lock.
      if (!taken.id)
        throw new RecordError('conflict', [{ field: '_record', code: 'not_in_a_queue' }]);
      return taken;
    });
  }
}
