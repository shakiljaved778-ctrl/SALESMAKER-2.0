import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { CreateLayoutQuery, FieldHistoryQuery, ObjectParam, RecordParam } from '@sm/contracts';
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

const localeOf = (ctx: RecordContext): string => {
  const locale = ctx.globals('User', 'locale');
  return typeof locale === 'string' ? locale : 'en';
};

/** The record page (§9.11 T2) and field history; access is decided per record and field. */
@Controller('v1')
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

  @Get('objects/:object/layout')
  layout(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(ObjectParam)) p: z.infer<typeof ObjectParam>,
    @Query(new ZodPipe(CreateLayoutQuery)) q: z.infer<typeof CreateLayoutQuery>,
  ) {
    return this.run(t, req, (tx, ctx) =>
      this.pages.layout(tx, ctx, p.object, q.recordTypeId, localeOf(ctx)),
    );
  }

  @Get('records/:object/:id/page')
  page(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(RecordParam)) p: Rec,
  ) {
    return this.run(t, req, (tx, ctx) => this.pages.page(tx, ctx, p.object, p.id, localeOf(ctx)));
  }

  @Get('records/:object/:id/history')
  history(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(RecordParam)) p: Rec,
    @Query(new ZodPipe(FieldHistoryQuery)) q: z.infer<typeof FieldHistoryQuery>,
  ) {
    return this.run(t, req, (tx, ctx) => this.pages.history(tx, ctx, p.object, p.id, q));
  }
}
