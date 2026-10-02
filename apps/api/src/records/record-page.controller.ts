import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { FieldHistoryQuery, RecordParam } from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext, type TenantTransaction } from '@sm/db';
import type { RecordContext } from '@sm/records';
import { ZodPipe } from '@sm/server-kit';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentTenant, TenantContextGuard } from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';
import { RecordContextService } from './record-context.service.js';
import { RecordPageService } from './record-page.service.js';

type Rec = z.infer<typeof RecordParam>;

/** The record page (§9.11 T2) and field history; access is decided per record and field. */
@Controller('v1/records/:object/:id')
@UseGuards(AuthGuard, TenantContextGuard)
export class RecordPageController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly contexts: RecordContextService,
    private readonly pages: RecordPageService,
  ) {}

  private run<T>(
    tenant: TenantContext,
    request: FastifyRequest,
    fn: (tx: TenantTransaction, ctx: RecordContext) => Promise<T>,
  ): Promise<T> {
    return withTenant(this.prisma, tenant, async (tx) =>
      fn(tx, await this.contexts.forCaller(tx, request.id)),
    );
  }

  @Get('page')
  page(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(RecordParam)) p: Rec,
  ) {
    return this.run(t, req, (tx, ctx) => {
      const locale = ctx.globals('User', 'locale');
      return this.pages.page(tx, ctx, p.object, p.id, typeof locale === 'string' ? locale : 'en');
    });
  }

  @Get('history')
  history(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(RecordParam)) p: Rec,
    @Query(new ZodPipe(FieldHistoryQuery)) q: z.infer<typeof FieldHistoryQuery>,
  ) {
    return this.run(t, req, (tx, ctx) => this.pages.history(tx, ctx, p.object, p.id, q));
  }
}
