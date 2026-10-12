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
  CreateScoringModelRequest,
  scoringRoutes,
  SetupIdParam,
  UpdateScoringModelRequest,
  type ScoreHistoryDto,
} from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext, type TenantTransaction } from '@sm/db';
import { fieldAccess, objectAccess } from '@sm/permissions';
import { hasAccess, RecordError } from '@sm/records';
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
import { ScoringSetupService } from './scoring-setup.service.js';

type Id = z.infer<typeof SetupIdParam>;
type Out<T extends z.ZodType> = z.output<T>;
const LeadParam = scoringRoutes.leadScoreHistory.request.params;

/** Setup → Lead scoring (§7.4). Reading needs view_setup, changes customize_application. */
@Controller('v1/setup/scoring-models')
@UseGuards(AuthGuard, TenantContextGuard, SystemPermissionGuard)
@RequireSystemPermission('view_setup')
export class ScoringModelsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly scoring: ScoringSetupService,
  ) {}

  private run<T>(ctx: TenantContext, fn: (tx: TenantTransaction) => Promise<T>) {
    return withTenant(this.prisma, ctx, fn);
  }

  @Get()
  async list(@CurrentTenant() ctx: TenantContext) {
    return { items: await this.run(ctx, (tx) => this.scoring.list(tx)) };
  }
  @Get(':id')
  get(@CurrentTenant() ctx: TenantContext, @Param(new ZodPipe(SetupIdParam)) p: Id) {
    return this.run(ctx, (tx) => this.scoring.get(tx, p.id));
  }
  @Post()
  @RequireSystemPermission('customize_application')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(CreateScoringModelRequest)) body: Out<typeof CreateScoringModelRequest>,
  ) {
    return this.run(ctx, (tx) => this.scoring.create(tx, body));
  }
  @Patch(':id')
  @RequireSystemPermission('customize_application')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(SetupIdParam)) p: Id,
    @Body(new ZodPipe(UpdateScoringModelRequest)) body: Out<typeof UpdateScoringModelRequest>,
  ) {
    return this.run(ctx, (tx) => this.scoring.update(tx, p.id, body));
  }
  @Delete(':id')
  @HttpCode(204)
  @RequireSystemPermission('customize_application')
  async remove(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(SetupIdParam)) p: Id,
  ): Promise<void> {
    await this.run(ctx, (tx) => this.scoring.remove(tx, p.id));
  }
}

/** A lead's score history (§7.4): visible leads, and only when the score field is readable. */
@Controller('v1/records/lead/:id/score-history')
@UseGuards(AuthGuard, TenantContextGuard)
export class ScoreHistoryController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly contexts: RecordContextService,
  ) {}

  @Get()
  history(
    @CurrentTenant() t: TenantContext,
    @Req() request: FastifyRequest,
    @Param(new ZodPipe(LeadParam)) p: z.infer<typeof LeadParam>,
  ): Promise<{ items: z.infer<typeof ScoreHistoryDto>[] }> {
    return withTenant(this.prisma, t, async (tx) =>
      translating(async () => {
        const ctx = await this.contexts.forCaller(tx, request.id);
        const lead = ctx.metadata.object('lead');
        if (
          !lead ||
          !objectAccess(ctx.permissions, 'lead').read ||
          !(await hasAccess(tx, ctx, lead, p.id, 'read'))
        )
          throw new RecordError('not_found');
        // FLS (§6.5): no score field, no score history.
        const score = lead.fields.find((f) => f.apiName === 'score');
        if (!score || !fieldAccess(ctx.permissions, 'lead', 'score', score).read)
          return { items: [] };
        const rows = await tx.prisma.scoreHistory.findMany({
          where: { object: 'lead', recordId: p.id },
          orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
          take: 50,
        });
        return {
          items: rows.map((r) => ({
            changedAt: r.changedAt.toISOString(),
            fit: r.fit,
            engagement: r.engagement,
            score: r.score,
            grade: r.grade,
            reason: r.reason as string[],
          })),
        };
      }),
    );
  }
}
