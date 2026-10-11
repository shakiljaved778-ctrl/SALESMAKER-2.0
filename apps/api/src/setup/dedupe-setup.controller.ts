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
  CreateDuplicateRuleRequest,
  CreateMatchingRuleRequest,
  SetupIdParam,
  TestMatchingRuleRequest,
  UpdateDuplicateRuleRequest,
  UpdateMatchingRuleRequest,
} from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext, type TenantTransaction } from '@sm/db';
import { findMatches, type MatchCondition } from '@sm/records';
import { errors, ZodPipe } from '@sm/server-kit';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import {
  RequireSystemPermission,
  SystemPermissionGuard,
} from '../access/system-permission.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { DuplicatesService } from '../records/duplicates.service.js';
import { RecordContextService } from '../records/record-context.service.js';
import { translating } from '../records/record-errors.js';
import { CurrentTenant, TenantContextGuard } from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';
import { DedupeSetupService } from './dedupe-setup.service.js';

type Id = z.infer<typeof SetupIdParam>;
type Out<T extends z.ZodType> = z.output<T>;

/** Setup → Duplicate management (§7.2). Reading needs view_setup, changes customize_application. */
@Controller('v1/setup')
@UseGuards(AuthGuard, TenantContextGuard, SystemPermissionGuard)
@RequireSystemPermission('view_setup')
export class DedupeSetupController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly setup: DedupeSetupService,
    private readonly duplicates: DuplicatesService,
    private readonly contexts: RecordContextService,
  ) {}

  private run<T>(ctx: TenantContext, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    return withTenant(this.prisma, ctx, fn);
  }

  @Get('matching-rules')
  async listMatchingRules(@CurrentTenant() ctx: TenantContext) {
    return { items: await this.run(ctx, (tx) => this.setup.listMatching(tx)) };
  }
  @Get('matching-rules/:id')
  getMatchingRule(@CurrentTenant() ctx: TenantContext, @Param(new ZodPipe(SetupIdParam)) p: Id) {
    return this.run(ctx, (tx) => this.setup.getMatching(tx, p.id));
  }
  @Post('matching-rules')
  @RequireSystemPermission('customize_application')
  createMatchingRule(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(CreateMatchingRuleRequest)) body: Out<typeof CreateMatchingRuleRequest>,
  ) {
    return this.run(ctx, (tx) => this.setup.createMatching(tx, body));
  }
  @Patch('matching-rules/:id')
  @RequireSystemPermission('customize_application')
  updateMatchingRule(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(SetupIdParam)) p: Id,
    @Body(new ZodPipe(UpdateMatchingRuleRequest)) body: Out<typeof UpdateMatchingRuleRequest>,
  ) {
    return this.run(ctx, (tx) => this.setup.updateMatching(tx, p.id, body));
  }
  @Delete('matching-rules/:id')
  @HttpCode(204)
  @RequireSystemPermission('customize_application')
  async deleteMatchingRule(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(SetupIdParam)) p: Id,
  ): Promise<void> {
    await this.run(ctx, (tx) => this.setup.deleteMatching(tx, p.id));
  }

  /** What a matching rule finds for a record or typed values, as the admin sees records. */
  @Post('matching-rules/:id/test')
  @HttpCode(200)
  testMatchingRule(
    @CurrentTenant() ctx: TenantContext,
    @Req() request: FastifyRequest,
    @Param(new ZodPipe(SetupIdParam)) p: Id,
    @Body(new ZodPipe(TestMatchingRuleRequest)) body: Out<typeof TestMatchingRuleRequest>,
  ) {
    return this.run(ctx, (tx) =>
      translating(async () => {
        const rule = await tx.prisma.matchingRule.findFirst({ where: { id: p.id } });
        if (!rule) throw errors.notFound('Matching rule');
        const records = await this.contexts.forCaller(tx, request.id);
        const object = this.duplicates.objectFor(records, rule.object);
        const values = body.recordId
          ? await this.duplicates.visibleValues(tx, records, object, body.recordId)
          : this.duplicates.readableValues(records, object, body.fields ?? {});
        const definition = {
          id: rule.id,
          name: rule.name,
          object: rule.object,
          conditions: rule.conditions as unknown as MatchCondition[],
          matchBlank: rule.matchBlank,
        };
        const found = await findMatches(tx, records, object, definition, [
          { index: 0, id: body.recordId ?? null, values },
        ]);
        return { matches: await this.duplicates.named(tx, records, object, found.get(0) ?? []) };
      }),
    );
  }

  @Get('duplicate-rules')
  async listDuplicateRules(@CurrentTenant() ctx: TenantContext) {
    return { items: await this.run(ctx, (tx) => this.setup.listDuplicate(tx)) };
  }
  @Get('duplicate-rules/:id')
  getDuplicateRule(@CurrentTenant() ctx: TenantContext, @Param(new ZodPipe(SetupIdParam)) p: Id) {
    return this.run(ctx, (tx) => this.setup.getDuplicate(tx, p.id));
  }
  @Post('duplicate-rules')
  @RequireSystemPermission('customize_application')
  createDuplicateRule(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(CreateDuplicateRuleRequest)) body: Out<typeof CreateDuplicateRuleRequest>,
  ) {
    return this.run(ctx, (tx) => this.setup.createDuplicate(tx, body));
  }
  @Patch('duplicate-rules/:id')
  @RequireSystemPermission('customize_application')
  updateDuplicateRule(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(SetupIdParam)) p: Id,
    @Body(new ZodPipe(UpdateDuplicateRuleRequest)) body: Out<typeof UpdateDuplicateRuleRequest>,
  ) {
    return this.run(ctx, (tx) => this.setup.updateDuplicate(tx, p.id, body));
  }
  @Delete('duplicate-rules/:id')
  @HttpCode(204)
  @RequireSystemPermission('customize_application')
  async deleteDuplicateRule(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(SetupIdParam)) p: Id,
  ): Promise<void> {
    await this.run(ctx, (tx) => this.setup.deleteDuplicate(tx, p.id));
  }
}
