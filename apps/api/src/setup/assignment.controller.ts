import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  type AssignmentLogDto,
  assignmentRoutes,
  CreateAssignmentRuleRequest,
  RunAssignmentRequest,
  SetupIdParam,
  UpdateAssignmentRuleRequest,
} from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext, type TenantTransaction } from '@sm/db';
import { objectAccess } from '@sm/permissions';
import {
  assignmentEnv,
  assignRecords,
  hasAccess,
  RecordError,
  type RecordContext,
} from '@sm/records';
import { ZodPipe } from '@sm/server-kit';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import {
  RequireSystemPermission,
  SystemPermissionGuard,
} from '../access/system-permission.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { RecordContextService } from '../records/record-context.service.js';
import { translating } from '../records/record-errors.js';
import { CurrentTenant, TenantContextGuard } from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';
import { AssignmentSetupService } from './assignment-setup.service.js';

type Id = z.infer<typeof SetupIdParam>;
type Out<T extends z.ZodType> = z.output<T>;
const RecordParam = assignmentRoutes.recordAssignment.request.params;

/** Setup → Assignment rules (§7.3). Reading needs view_setup, changes customize_application. */
@Controller('v1/setup/assignment-rules')
@UseGuards(AuthGuard, TenantContextGuard, SystemPermissionGuard)
@RequireSystemPermission('view_setup')
export class AssignmentRulesController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly rules: AssignmentSetupService,
  ) {}

  private run<T>(ctx: TenantContext, fn: (tx: TenantTransaction) => Promise<T>) {
    return withTenant(this.prisma, ctx, fn);
  }

  @Get()
  async list(@CurrentTenant() ctx: TenantContext) {
    return { items: await this.run(ctx, (tx) => this.rules.list(tx)) };
  }
  @Get(':id')
  get(@CurrentTenant() ctx: TenantContext, @Param(new ZodPipe(SetupIdParam)) p: Id) {
    return this.run(ctx, (tx) => this.rules.get(tx, p.id));
  }
  @Post()
  @RequireSystemPermission('customize_application')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(CreateAssignmentRuleRequest)) body: Out<typeof CreateAssignmentRuleRequest>,
  ) {
    return this.run(ctx, (tx) => this.rules.create(tx, body));
  }
  @Patch(':id')
  @RequireSystemPermission('customize_application')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(SetupIdParam)) p: Id,
    @Body(new ZodPipe(UpdateAssignmentRuleRequest)) body: Out<typeof UpdateAssignmentRuleRequest>,
  ) {
    return this.run(ctx, (tx) => this.rules.update(tx, p.id, body));
  }
  @Delete(':id')
  @HttpCode(204)
  @RequireSystemPermission('customize_application')
  async remove(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(SetupIdParam)) p: Id,
  ): Promise<void> {
    await this.run(ctx, (tx) => this.rules.remove(tx, p.id));
  }
}

/** Running rules on demand, and "Why was this assigned to me?" (§7.3). */
@Controller('v1')
@UseGuards(AuthGuard, TenantContextGuard)
export class AssignmentController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly contexts: RecordContextService,
  ) {}

  private runAs<T>(
    t: TenantContext,
    request: FastifyRequest,
    fn: (tx: TenantTransaction, ctx: RecordContext) => Promise<T>,
  ) {
    return withTenant(this.prisma, t, async (tx) =>
      translating(async () => fn(tx, await this.contexts.forCaller(tx, request.id))),
    );
  }

  @Post('assignment/run')
  @HttpCode(200)
  @UseGuards(SystemPermissionGuard)
  @RequireSystemPermission('transfer_records')
  runRules(
    @CurrentTenant() t: TenantContext,
    @Req() request: FastifyRequest,
    @Body(new ZodPipe(RunAssignmentRequest)) body: Out<typeof RunAssignmentRequest>,
  ) {
    return this.runAs(t, request, async (tx, ctx) => {
      const object = ctx.metadata.object(body.object);
      if (!object || !objectAccess(ctx.permissions, body.object).edit)
        throw new RecordError('forbidden');
      if (
        body.ruleId &&
        !(await tx.prisma.assignmentRule.findFirst({
          where: { id: body.ruleId, object: body.object },
        }))
      )
        throw new RecordError('not_found');
      const ids = [...new Set(body.recordIds)];
      const allowed: string[] = [];
      const results = new Map<
        string,
        { recordId: string; ok: boolean; error?: 'not_found' | 'forbidden' }
      >();
      for (const id of ids) {
        // Reassigning is a transfer: Full access on the record (§6.3).
        if (!(await hasAccess(tx, ctx, object, id, 'read')))
          results.set(id, { recordId: id, ok: false, error: 'not_found' });
        else if (!(await hasAccess(tx, ctx, object, id, 'full')))
          results.set(id, { recordId: id, ok: false, error: 'forbidden' });
        else allowed.push(id);
      }
      const outcomes = await assignRecords(tx, assignmentEnv(ctx), body.object, allowed, {
        source: 'run',
        ruleId: body.ruleId ?? null,
      });
      const byId = new Map(outcomes.map((o) => [o.recordId, o]));
      return {
        results: ids.map((id) => {
          const failed = results.get(id);
          if (failed) return failed;
          const o = byId.get(id);
          return o
            ? {
                recordId: id,
                ok: true,
                ownerType: o.ownerType,
                ownerId: o.ownerId,
                method: o.method,
                reason: o.reason,
                changed: o.changed,
              }
            : { recordId: id, ok: true };
        }),
      };
    });
  }

  @Get('records/:object/:id/assignment')
  history(
    @CurrentTenant() t: TenantContext,
    @Req() request: FastifyRequest,
    @Param(new ZodPipe(RecordParam)) p: z.infer<typeof RecordParam>,
  ): Promise<{ items: z.infer<typeof AssignmentLogDto>[] }> {
    return this.runAs(t, request, async (tx, ctx) => {
      const object = ctx.metadata.object(p.object);
      if (
        !object ||
        !objectAccess(ctx.permissions, p.object).read ||
        !(await hasAccess(tx, ctx, object, p.id, 'read'))
      )
        throw new RecordError('not_found');
      const logs = await tx.prisma.assignmentLog.findMany({
        where: { object: p.object, recordId: p.id },
        orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
        take: 20,
      });
      const userIds = new Set<string>();
      const queueIds = new Set<string>();
      for (const l of logs) {
        (l.ownerType === 'QUEUE' ? queueIds : userIds).add(l.ownerId);
        for (const c of l.candidates as { userId: string }[]) userIds.add(c.userId);
      }
      const [users, queues, rules] = await Promise.all([
        tx.prisma.user.findMany({
          where: { id: { in: [...userIds] } },
          select: { id: true, name: true },
        }),
        tx.prisma.queue.findMany({
          where: { id: { in: [...queueIds] } },
          select: { id: true, name: true },
        }),
        tx.prisma.assignmentRule.findMany({
          where: { id: { in: logs.flatMap((l) => (l.ruleId ? [l.ruleId] : [])) } },
          select: { id: true, name: true },
        }),
      ]);
      const names = new Map([...users, ...queues, ...rules].map((x) => [x.id, x.name]));
      return {
        items: logs.map((l) => ({
          id: l.id,
          assignedAt: l.assignedAt.toISOString(),
          method: l.method,
          owner: {
            type: l.ownerType as 'USER' | 'QUEUE',
            id: l.ownerId,
            name: names.get(l.ownerId) ?? null,
          },
          previousOwnerId: l.previousOwnerId,
          reason: l.reason,
          source: l.source,
          rule: l.ruleId ? { id: l.ruleId, name: names.get(l.ruleId) ?? null } : null,
          candidates: (l.candidates as { userId: string; skipped?: string }[]).map((c) => ({
            userId: c.userId,
            name: names.get(c.userId) ?? null,
            ...(c.skipped ? { skipped: c.skipped } : {}),
          })),
        })),
      };
    });
  }
}
