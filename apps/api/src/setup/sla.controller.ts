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
  CreateSlaPolicyRequest,
  SetupIdParam,
  slaRoutes,
  SlaStatusRequest,
  UpdateSlaPolicyRequest,
  type SlaTimerDto,
} from '@sm/contracts';
import {
  audit,
  withTenant,
  type CellPrisma,
  type TenantContext,
  type TenantTransaction,
} from '@sm/db';
import { objectAccess } from '@sm/permissions';
import { sharingPredicate } from '@sm/query-engine';
import { hasAccess, meetSlaTimers, RecordError, type RecordContext } from '@sm/records';
import { ZodPipe } from '@sm/server-kit';
import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
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
import { SlaSetupService, timerDto } from './sla-setup.service.js';

type Id = z.infer<typeof SetupIdParam>;
type Out<T extends z.ZodType> = z.output<T>;
type Timer = z.infer<typeof SlaTimerDto>;
const LeadParam = slaRoutes.touchLead.request.params;

/** Setup → SLA policies (§7.3). Reading needs view_setup, changes customize_application. */
@Controller('v1/setup/sla-policies')
@UseGuards(AuthGuard, TenantContextGuard, SystemPermissionGuard)
@RequireSystemPermission('view_setup')
export class SlaPoliciesController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly sla: SlaSetupService,
  ) {}

  private run<T>(ctx: TenantContext, fn: (tx: TenantTransaction) => Promise<T>) {
    return withTenant(this.prisma, ctx, fn);
  }

  @Get()
  async list(@CurrentTenant() ctx: TenantContext) {
    return { items: await this.run(ctx, (tx) => this.sla.list(tx)) };
  }
  @Get(':id')
  get(@CurrentTenant() ctx: TenantContext, @Param(new ZodPipe(SetupIdParam)) p: Id) {
    return this.run(ctx, (tx) => this.sla.get(tx, p.id));
  }
  @Post()
  @RequireSystemPermission('customize_application')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(CreateSlaPolicyRequest)) body: Out<typeof CreateSlaPolicyRequest>,
  ) {
    return this.run(ctx, (tx) => this.sla.create(tx, body));
  }
  @Patch(':id')
  @RequireSystemPermission('customize_application')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(SetupIdParam)) p: Id,
    @Body(new ZodPipe(UpdateSlaPolicyRequest)) body: Out<typeof UpdateSlaPolicyRequest>,
  ) {
    return this.run(ctx, (tx) => this.sla.update(tx, p.id, body));
  }
  @Delete(':id')
  @HttpCode(204)
  @RequireSystemPermission('customize_application')
  async remove(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(SetupIdParam)) p: Id,
  ): Promise<void> {
    await this.run(ctx, (tx) => this.sla.remove(tx, p.id));
  }
}

/** SLA clocks on records (§7.3): touch, a record's clocks, and chips for list pages. */
@Controller('v1')
@UseGuards(AuthGuard, TenantContextGuard)
export class SlaController {
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

  private lead(ctx: RecordContext) {
    const lead = ctx.metadata.object('lead');
    if (!lead || !objectAccess(ctx.permissions, 'lead').read) throw new RecordError('not_found');
    return lead;
  }

  private async timers(
    tx: TenantTransaction,
    ids: readonly string[],
  ): Promise<Map<string, Timer[]>> {
    const rows = await tx.prisma.slaTimer.findMany({
      where: { object: 'lead', recordId: { in: [...ids] } },
      include: { policy: { select: { id: true, name: true, metric: true } } },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    });
    const now = new Date();
    const out = new Map<string, Timer[]>();
    for (const r of rows) out.set(r.recordId, [...(out.get(r.recordId) ?? []), timerDto(r, now)]);
    return out;
  }

  @Post('records/lead/:id/touch')
  @HttpCode(200)
  touch(
    @CurrentTenant() t: TenantContext,
    @Req() request: FastifyRequest,
    @Param(new ZodPipe(LeadParam)) p: z.infer<typeof LeadParam>,
  ) {
    return this.runAs(t, request, async (tx, ctx) => {
      const lead = this.lead(ctx);
      if (!(await hasAccess(tx, ctx, lead, p.id, 'read'))) throw new RecordError('not_found');
      if (
        !objectAccess(ctx.permissions, 'lead').edit ||
        !(await hasAccess(tx, ctx, lead, p.id, 'edit'))
      )
        throw new RecordError('forbidden');
      const met = await meetSlaTimers(tx, 'lead', p.id, 'FIRST_TOUCH', new Date());
      await audit.record(tx, {
        action: 'record.touched',
        object: 'lead',
        recordId: p.id,
        payload: { slaTimersMet: met },
        ...(request.id ? { requestId: request.id } : {}),
      });
      return { met };
    });
  }

  @Get('records/lead/:id/sla')
  record(
    @CurrentTenant() t: TenantContext,
    @Req() request: FastifyRequest,
    @Param(new ZodPipe(LeadParam)) p: z.infer<typeof LeadParam>,
  ): Promise<{ items: Timer[] }> {
    return this.runAs(t, request, async (tx, ctx) => {
      const lead = this.lead(ctx);
      if (!(await hasAccess(tx, ctx, lead, p.id, 'read'))) throw new RecordError('not_found');
      return { items: (await this.timers(tx, [p.id])).get(p.id) ?? [] };
    });
  }

  @Post('sla/status')
  @HttpCode(200)
  status(
    @CurrentTenant() t: TenantContext,
    @Req() request: FastifyRequest,
    @Body(new ZodPipe(SlaStatusRequest)) body: z.infer<typeof SlaStatusRequest>,
  ): Promise<{ items: { recordId: string; timers: Timer[] }[] }> {
    return this.runAs(t, request, async (tx, ctx) => {
      const lead = this.lead(ctx);
      const visible = (
        await sql<{ id: string }>`SELECT r.id FROM lead AS r
          WHERE r.tenant_id = ${tx.context.tenantId}::uuid AND r.id = ANY (${sql.val([...new Set(body.ids)])}::uuid[])
            AND r.deleted_at IS NULL AND ${sharingPredicate(ctx.sharing, lead.apiName, 'r', 'read')}`.execute(
          tx.kysely,
        )
      ).rows.map((r) => r.id);
      const timers = await this.timers(tx, visible);
      return { items: visible.map((id) => ({ recordId: id, timers: timers.get(id) ?? [] })) };
    });
  }
}
