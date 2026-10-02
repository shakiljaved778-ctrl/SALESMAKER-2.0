import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConvertLeadRequest, LeadParam, PutFieldMappingRequest } from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext, type TenantTransaction } from '@sm/db';
import {
  convertLead,
  effectiveMappings,
  saveMappings,
  undoConversion,
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
import { CurrentTenant, TenantContextGuard } from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';
import { RecordContextService } from './record-context.service.js';
import { translating } from './record-errors.js';

type Lead = z.infer<typeof LeadParam>;

/** Lead conversion (§7.3): one transaction through RecordService, as the caller. */
@Controller('v1/leads')
@UseGuards(AuthGuard, TenantContextGuard)
export class LeadsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly contexts: RecordContextService,
  ) {}

  private run<T>(
    tenant: TenantContext,
    request: FastifyRequest,
    fn: (tx: TenantTransaction, ctx: RecordContext) => Promise<T>,
  ): Promise<T> {
    return withTenant(this.prisma, tenant, async (tx) =>
      translating(async () => fn(tx, await this.contexts.forCaller(tx, request.id))),
    );
  }

  @Post(':id/convert')
  @HttpCode(200)
  convertLead(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(LeadParam)) p: Lead,
    @Body(new ZodPipe(ConvertLeadRequest)) body: z.infer<typeof ConvertLeadRequest>,
  ) {
    return this.run(t, req, (tx, ctx) => convertLead(tx, ctx, p.id, body));
  }

  @Post(':id/convert/undo')
  @HttpCode(204)
  async undoLeadConversion(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(LeadParam)) p: Lead,
  ) {
    await this.run(t, req, (tx, ctx) => undoConversion(tx, ctx, p.id));
  }
}

/** Setup → lead conversion mapping. Reading needs view_setup; replacing it customize_application. */
@Controller('v1/leads/field-mapping')
@UseGuards(AuthGuard, TenantContextGuard, SystemPermissionGuard)
@RequireSystemPermission('view_setup')
export class LeadMappingController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly contexts: RecordContextService,
  ) {}

  private static async view(tx: TenantTransaction) {
    const effective = await effectiveMappings(tx);
    const custom = (
      await tx.prisma.leadFieldMapping.findMany({ orderBy: { createdAt: 'asc' } })
    ).map((m) => ({
      leadField: m.leadField,
      targetObject: m.targetObject as 'account' | 'contact' | 'opportunity',
      targetField: m.targetField,
    }));
    return { effective, custom };
  }

  @Get()
  getLeadFieldMapping(@CurrentTenant() t: TenantContext) {
    return withTenant(this.prisma, t, (tx) => LeadMappingController.view(tx));
  }

  @Put()
  @RequireSystemPermission('customize_application')
  putLeadFieldMapping(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Body(new ZodPipe(PutFieldMappingRequest)) body: z.infer<typeof PutFieldMappingRequest>,
  ) {
    return withTenant(this.prisma, t, (tx) =>
      translating(async () => {
        const ctx = await this.contexts.forCaller(tx, req.id);
        await saveMappings(tx, ctx.metadata, body.mappings);
        return LeadMappingController.view(tx);
      }),
    );
  }
}
